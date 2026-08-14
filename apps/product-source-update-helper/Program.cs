using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace GoatCitadel.ProductSourceUpdateHelper;

internal static partial class Program
{
    private const int MaxRequestBytes = 4 * 1024 * 1024;
    private const int MaxProcessOutputBytes = 8 * 1024 * 1024;
    private enum RecoveryState { Baseline, PatchStaged, PatchCommitted, CompensationStaged, CompensationCommitted }
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static async Task<int> Main(string[] args)
    {
        try
        {
            var arguments = ParseArguments(args);
            var requestPath = CanonicalFile(arguments.RequestPath, "request");
            var requestDirectory = Path.GetDirectoryName(requestPath)
                ?? throw new HelperException("request_path_invalid", "Request path has no directory.");
            AssertNoReparsePath(requestDirectory, includeLeaf: true);
            var requestBytes = await ReadBoundedAsync(requestPath, MaxRequestBytes);
            if (!FixedEquals(Sha256(requestBytes), arguments.RequestSha256))
            {
                throw new HelperException("request_hash_mismatch", "Request bytes do not match the Gateway-bound hash.");
            }

            var request = JsonSerializer.Deserialize<HelperRequest>(requestBytes, JsonOptions)
                ?? throw new HelperException("request_contract_invalid", "Request JSON is empty.");
            ValidateRequest(request, requestDirectory);
            using var operationLock = AcquireOperationLock(requestDirectory);
            var journal = new DurableJournal(request.JournalPath, request.ManifestId);
            journal.Append("request_verified", new { request.Operation, request.ManifestId, request.InstallId });

            if (ExistingResultIsBound(request, arguments.RequestSha256)) return 0;
            await WaitForGatewayExitAsync(request.ParentPid, request.ParentStartedAtUnixMs, journal);
            return await ExecuteAsync(request, arguments.RequestSha256, journal);
        }
        catch (HelperException error)
        {
            Console.Error.WriteLine($"{error.Code}: {error.Message}");
            return 2;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"helper_unhandled: {error.GetType().Name}: {error.Message}");
            return 3;
        }
    }

    private static async Task<int> ExecuteAsync(HelperRequest request, string requestSha256, DurableJournal journal)
    {
        var mutationStarted = false;
        try
        {
            var recovery = InspectRecoveryState(request);
            journal.Append("recovery_state_observed", new { state = recovery.ToString().ToLowerInvariant() });
            if (recovery is RecoveryState.CompensationStaged)
            {
                mutationStarted = true;
                CommitCompensation(request);
                var restored = InspectCleanHead(request.SourceRoot);
                await EnsureRuntimeHealthyAsync(request.Restart, journal);
                journal.Append("automatic_rollback_succeeded", new { baselineSha = restored.Head, baselineTree = restored.Tree, recovered = true });
                WriteResult(request, requestSha256, "rolled_back", restored.Head, restored.Tree, null, journal);
                return 6;
            }
            if (recovery is RecoveryState.CompensationCommitted)
            {
                mutationStarted = true;
                var restored = InspectCleanHead(request.SourceRoot);
                await EnsureRuntimeHealthyAsync(request.Restart, journal);
                journal.Append("automatic_rollback_succeeded", new { baselineSha = restored.Head, baselineTree = restored.Tree, recovered = true });
                WriteResult(request, requestSha256, "rolled_back", restored.Head, restored.Tree, null, journal);
                return 6;
            }
            if (recovery is RecoveryState.Baseline)
            {
                RevalidateSource(request);
                VerifyChangedFileHashes(request.SourceRoot, request.ChangedFiles, useBefore: true);
                journal.Append("source_revalidated", new { request.ExpectedHead, request.ExpectedTree });

                // A byte-clean working tree can still carry stale index stat metadata
                // after a file was restored. Refresh metadata only after the exact
                // baseline and changed-file hashes have been revalidated.
                GitMutable(request.SourceRoot, "update-index", "--refresh");
                Git(request.SourceRoot, "apply", "--check", "--whitespace=nowarn", "--", request.PatchPath);
                GitMutable(request.SourceRoot, "apply", "--index", "--whitespace=nowarn", "--", request.PatchPath);
                mutationStarted = true;
                VerifyChangedFileHashes(request.SourceRoot, request.ChangedFiles, useBefore: false);
                journal.Append("patch_applied", new { request.PatchSha256, changedFiles = request.ChangedFiles.Count });
            }
            else
            {
                mutationStarted = true;
                journal.Append("patch_recovered", new { state = recovery.ToString().ToLowerInvariant() });
            }

            if (recovery is RecoveryState.Baseline or RecoveryState.PatchStaged)
            {
                CommitExactPatch(request);
            }
            var applied = InspectCleanHead(request.SourceRoot);
            VerifyChangedFileHashes(request.SourceRoot, request.ChangedFiles, useBefore: false);
            journal.Append("patch_committed", new { baselineSha = applied.Head, baselineTree = applied.Tree });

            await EnsureRuntimeHealthyAsync(request.Restart, journal);
            var successStatus = request.Operation == "rollback" ? "rolled_back" : "succeeded";
            WriteResult(request, requestSha256, successStatus, applied.Head, applied.Tree, null, journal);
            return 0;
        }
        catch (Exception error)
        {
            journal.Append("apply_failed", new { code = FailureCode(error) });
            if (!mutationStarted)
            {
                TryStartRuntime(request.Restart, journal);
                WriteResult(request, requestSha256, request.Operation == "rollback" ? "rollback_failed" : "failed", null, null, FailureCode(error), journal);
                return 4;
            }

            if (request.Operation == "rollback")
            {
                WriteResult(request, requestSha256, "rollback_failed", null, null, FailureCode(error), journal);
                return 5;
            }

            try
            {
                journal.Append("automatic_rollback_started", new { request.ManifestId });
                ApplyCompensation(request);
                var restored = InspectCleanHead(request.SourceRoot);
                await EnsureRuntimeHealthyAsync(request.Restart, journal);
                journal.Append("automatic_rollback_succeeded", new { baselineSha = restored.Head, baselineTree = restored.Tree });
                WriteResult(request, requestSha256, "rolled_back", restored.Head, restored.Tree, null, journal);
                return 6;
            }
            catch (Exception rollbackError)
            {
                journal.Append("automatic_rollback_failed", new { code = FailureCode(rollbackError) });
                WriteResult(request, requestSha256, "rollback_failed", null, null, FailureCode(rollbackError), journal);
                return 7;
            }
        }
    }

    private static void RevalidateSource(HelperRequest request)
    {
        ValidateSourceEnvelope(request);
        var sourceRoot = request.SourceRoot;
        if (Git(sourceRoot, "rev-parse", "HEAD") != request.ExpectedHead || Git(sourceRoot, "rev-parse", "HEAD^{tree}") != request.ExpectedTree)
        {
            throw new HelperException("source_baseline_stale", "Source baseline changed before apply.");
        }
        if (Git(sourceRoot, "status", "--porcelain=v1", "--untracked-files=all").Length != 0)
        {
            throw new HelperException("source_dirty", "Source root is not clean at the apply boundary.");
        }
    }

    private static void ValidateSourceEnvelope(HelperRequest request)
    {
        var sourceRoot = CanonicalDirectory(request.SourceRoot, "source root");
        if (sourceRoot == Path.GetPathRoot(sourceRoot) || sourceRoot.StartsWith("\\\\", StringComparison.Ordinal))
        {
            throw new HelperException("source_root_unsafe", "Source root must be a non-root local path.");
        }
        AssertNoReparsePath(sourceRoot, includeLeaf: true);
        var drive = new DriveInfo(Path.GetPathRoot(sourceRoot)!);
        if (drive.DriveType != DriveType.Fixed)
        {
            throw new HelperException("source_volume_unsafe", "Source update requires a fixed local volume.");
        }
        RequireRegularDirectory(Path.Join(sourceRoot, ".git"), "git directory");
        foreach (var marker in new[] { "package.json", "pnpm-workspace.yaml", "apps/gateway/package.json", "apps/mission-control-next/package.json", "docs/1_0_CONTRACT.md" })
        {
            RequireRegularFile(JoinRelative(sourceRoot, marker), $"marker {marker}");
        }

        var package = JsonDocument.Parse(File.ReadAllBytes(Path.Join(sourceRoot, "package.json")));
        if (!package.RootElement.TryGetProperty("name", out var name) || name.GetString() != "goatcitadel")
        {
            throw new HelperException("source_identity_invalid", "Source package identity is not GoatCitadel.");
        }
        var gitRoot = Path.GetFullPath(Git(sourceRoot, "rev-parse", "--show-toplevel")).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (!string.Equals(gitRoot, sourceRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new HelperException("source_git_root_mismatch", "Git reports a different source root.");
        }
        RequireRegularFile(request.PatchPath, "approved patch");
        if (Path.GetDirectoryName(request.PatchPath) != Path.GetDirectoryName(request.ResultPath))
        {
            throw new HelperException("artifact_jail_mismatch", "Patch and result are not in the same private operation directory.");
        }
        if (!FixedEquals(Sha256(File.ReadAllBytes(request.PatchPath)), request.PatchSha256))
        {
            throw new HelperException("patch_hash_mismatch", "Approved patch bytes changed before apply.");
        }
        RequireRegularFile(request.CompensationPath, "approved compensation");
        if (!FixedEquals(Sha256(File.ReadAllBytes(request.CompensationPath)), request.CompensationSha256))
        {
            throw new HelperException("compensation_hash_mismatch", "Approved compensation bytes changed before apply.");
        }
        foreach (var file in request.ChangedFiles)
        {
            AssertSafeRelativePath(file.Path);
            var target = JoinRelative(sourceRoot, file.Path);
            AssertNoReparsePath(target, includeLeaf: File.Exists(target) || Directory.Exists(target));
        }
    }

    private static RecoveryState InspectRecoveryState(HelperRequest request)
    {
        ValidateSourceEnvelope(request);
        var sourceRoot = request.SourceRoot;
        var head = RequireGitObject(Git(sourceRoot, "rev-parse", "HEAD"));
        var tree = RequireGitObject(Git(sourceRoot, "rev-parse", "HEAD^{tree}"));
        var dirty = Git(sourceRoot, "status", "--porcelain=v1", "--untracked-files=all").Length != 0;
        if (head == request.ExpectedHead)
        {
            if (!dirty && tree == request.ExpectedTree) return RecoveryState.Baseline;
            if (
                dirty
                && ChangedPathsExactly(sourceRoot, request.ChangedFiles, committed: false)
                && GitCheck(sourceRoot, "apply", "--reverse", "--check", "--index", "--", request.PatchPath)
            )
            {
                VerifyChangedFileHashes(sourceRoot, request.ChangedFiles, useBefore: false);
                return RecoveryState.PatchStaged;
            }
            throw new HelperException("recovery_state_ambiguous", "The source changed from the approved baseline in an unrecognized way.");
        }

        var operationLabel = request.Operation == "rollback" ? "rollback" : "apply";
        var patchSubject = $"goatcitadel: {operationLabel} governed source update {request.ManifestId}";
        var subject = Git(sourceRoot, "log", "-1", "--pretty=%s");
        var parent = RequireGitObject(Git(sourceRoot, "rev-parse", "HEAD^"));
        if (subject == patchSubject && parent == request.ExpectedHead && ChangedPathsExactly(sourceRoot, request.ChangedFiles, committed: true))
        {
            if (!dirty)
            {
                VerifyChangedFileHashes(sourceRoot, request.ChangedFiles, useBefore: false);
                return RecoveryState.PatchCommitted;
            }
            if (
                request.Operation == "apply"
                && ChangedPathsExactly(sourceRoot, request.ChangedFiles, committed: false)
                && GitCheck(sourceRoot, "apply", "--reverse", "--check", "--index", "--", request.CompensationPath)
            )
            {
                VerifyChangedFileHashes(sourceRoot, request.ChangedFiles, useBefore: true);
                return RecoveryState.CompensationStaged;
            }
        }

        var compensationSubject = $"goatcitadel: compensate failed source update {request.ManifestId}";
        if (request.Operation == "apply" && !dirty && subject == compensationSubject && tree == request.ExpectedTree)
        {
            var appliedCommit = parent;
            var originalCommit = RequireGitObject(Git(sourceRoot, "rev-parse", $"{appliedCommit}^"));
            var appliedSubject = Git(sourceRoot, "log", "-1", "--pretty=%s", appliedCommit);
            if (
                originalCommit == request.ExpectedHead
                && appliedSubject == patchSubject
                && ChangedPathsExactly(sourceRoot, request.ChangedFiles, committed: true)
            )
            {
                VerifyChangedFileHashes(sourceRoot, request.ChangedFiles, useBefore: true);
                return RecoveryState.CompensationCommitted;
            }
        }
        throw new HelperException("recovery_state_ambiguous", "The helper cannot prove a safe continuation or compensation state.");
    }

    private static bool ChangedPathsExactly(string sourceRoot, IReadOnlyList<ChangedFile> files, bool committed)
    {
        var raw = committed
            ? Git(sourceRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD")
            : Git(sourceRoot, "diff", "--name-only", "-z", "HEAD", "--", ".");
        var observed = raw.Split('\0', StringSplitOptions.RemoveEmptyEntries).Order(StringComparer.Ordinal).ToArray();
        var expected = files.Select(file => file.Path).Order(StringComparer.Ordinal).ToArray();
        return observed.SequenceEqual(expected, StringComparer.Ordinal);
    }

    private static bool GitCheck(string sourceRoot, params string[] args)
    {
        try
        {
            Git(sourceRoot, args);
            return true;
        }
        catch (HelperException error) when (error.Code == "git_operation_failed")
        {
            return false;
        }
    }

    private static void VerifyChangedFileHashes(string sourceRoot, IReadOnlyList<ChangedFile> files, bool useBefore)
    {
        foreach (var file in files)
        {
            var expected = useBefore ? file.BeforeSha256 : file.AfterSha256;
            var target = JoinRelative(sourceRoot, file.Path);
            if (expected is null)
            {
                if (File.Exists(target))
                {
                    throw new HelperException("changed_file_presence_drift", $"Changed file presence drifted: {file.Path}");
                }
                continue;
            }
            RequireRegularFile(target, $"changed file {file.Path}");
            if (!FixedEquals(Sha256(File.ReadAllBytes(target)), expected))
            {
                throw new HelperException("changed_file_hash_drift", $"Changed file hash drifted: {file.Path}");
            }
        }
    }

    private static void CommitExactPatch(HelperRequest request)
    {
        var operationLabel = request.Operation == "rollback" ? "rollback" : "apply";
        GitMutable(
            request.SourceRoot,
            "-c", "user.name=GoatCitadel Evolution",
            "-c", "user.email=evolution@localhost",
            "commit", "--no-gpg-sign", "-m", $"goatcitadel: {operationLabel} governed source update {request.ManifestId}"
        );
    }

    private static void ApplyCompensation(HelperRequest request)
    {
        RequireRegularFile(request.CompensationPath, "compensation patch");
        if (!FixedEquals(Sha256(File.ReadAllBytes(request.CompensationPath)), request.CompensationSha256))
        {
            throw new HelperException("compensation_hash_mismatch", "Approved compensation bytes changed before rollback.");
        }
        GitMutable(request.SourceRoot, "apply", "--index", "--whitespace=nowarn", "--", request.CompensationPath);
        CommitCompensation(request);
    }

    private static void CommitCompensation(HelperRequest request)
    {
        GitMutable(
            request.SourceRoot,
            "-c", "user.name=GoatCitadel Evolution",
            "-c", "user.email=evolution@localhost",
            "commit", "--no-gpg-sign", "-m", $"goatcitadel: compensate failed source update {request.ManifestId}"
        );
    }

    private static (string Head, string Tree) InspectCleanHead(string sourceRoot)
    {
        if (Git(sourceRoot, "status", "--porcelain=v1", "--untracked-files=all").Length != 0)
        {
            throw new HelperException("source_not_clean_after_commit", "Source root is not clean after the governed commit.");
        }
        return (RequireGitObject(Git(sourceRoot, "rev-parse", "HEAD")), RequireGitObject(Git(sourceRoot, "rev-parse", "HEAD^{tree}")));
    }

    private static async Task WaitForGatewayExitAsync(int parentPid, long parentStartedAtUnixMs, DurableJournal journal)
    {
        await Task.Delay(TimeSpan.FromSeconds(2));
        try
        {
            using var parent = Process.GetProcessById(parentPid);
            if (parent.HasExited) return;
            var observedStartedAt = new DateTimeOffset(parent.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();
            if (Math.Abs(observedStartedAt - parentStartedAtUnixMs) > 2_000)
            {
                journal.Append("gateway_pid_reused", new { parentPid });
                return;
            }
            journal.Append("gateway_shutdown_wait", new { parentPid });
            if (parent.WaitForExit(15_000)) return;
            parent.Kill(entireProcessTree: false);
            if (!parent.WaitForExit(10_000))
            {
                throw new HelperException("gateway_shutdown_failed", "Gateway process did not exit before source apply.");
            }
            journal.Append("gateway_process_terminated", new { parentPid });
        }
        catch (ArgumentException)
        {
            // Process already exited before the helper acquired its handle.
        }
    }

    private static FileStream AcquireOperationLock(string requestDirectory)
    {
        var lockPath = Path.Join(requestDirectory, "native-helper.lock");
        AssertNoReparsePath(requestDirectory, includeLeaf: true);
        try
        {
            return new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.WriteThrough);
        }
        catch (IOException)
        {
            throw new HelperException("operation_already_running", "Another native helper already owns this operation.");
        }
    }

    private static bool ExistingResultIsBound(HelperRequest request, string requestSha256)
    {
        if (!File.Exists(request.ResultPath)) return false;
        RequireRegularFile(request.ResultPath, "existing helper result");
        var bytes = File.ReadAllBytes(request.ResultPath);
        if (bytes.Length > 64 * 1024) throw new HelperException("result_contract_invalid", "Existing result exceeds its bound.");
        var result = JsonSerializer.Deserialize<HelperResult>(bytes, JsonOptions)
            ?? throw new HelperException("result_contract_invalid", "Existing result is empty.");
        if (
            result.SchemaVersion != 1
            || result.Operation != request.Operation
            || result.ManifestId != request.ManifestId
            || !FixedEquals(result.RequestSha256, requestSha256)
            || result.Status is not ("succeeded" or "rolled_back" or "failed" or "rollback_failed")
            || !Sha256Regex().IsMatch(result.EvidenceSha256)
        )
        {
            throw new HelperException("result_immutability_conflict", "Existing result is not bound to this exact request.");
        }
        return true;
    }

    private static void StartRuntime(RestartDescriptor restart, DurableJournal journal)
    {
        RequireRegularFile(restart.Executable, "restart executable");
        var workingDirectory = CanonicalDirectory(restart.WorkingDirectory, "restart working directory");
        var info = new ProcessStartInfo
        {
            FileName = restart.Executable,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var argument in restart.Args) info.ArgumentList.Add(argument);
        var process = Process.Start(info) ?? throw new HelperException("restart_launch_failed", "Restart process did not start.");
        journal.Append("runtime_restart_launched", new { processId = process.Id });
        process.Dispose();
    }

    private static async Task EnsureRuntimeHealthyAsync(RestartDescriptor restart, DurableJournal journal)
    {
        if (await IsRuntimeHealthyAsync(restart.HealthUrl, TimeSpan.FromSeconds(2)))
        {
            journal.Append("runtime_already_healthy", new { restart.HealthUrl });
            return;
        }
        StartRuntime(restart, journal);
        await SmokeAsync(restart, journal);
    }

    private static async Task<bool> IsRuntimeHealthyAsync(string healthUrl, TimeSpan timeout)
    {
        using var client = new HttpClient { Timeout = timeout };
        try
        {
            using var response = await client.GetAsync(healthUrl);
            return response.IsSuccessStatusCode;
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            return false;
        }
    }

    private static void TryStartRuntime(RestartDescriptor restart, DurableJournal journal)
    {
        try { StartRuntime(restart, journal); }
        catch (Exception error) { journal.Append("runtime_restart_recovery_failed", new { code = FailureCode(error) }); }
    }

    private static async Task SmokeAsync(RestartDescriptor restart, DurableJournal journal)
    {
        if (!Uri.TryCreate(restart.HealthUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttp || !IPAddress.TryParse(uri.Host, out var ip) || !IPAddress.IsLoopback(ip))
        {
            throw new HelperException("smoke_url_unsafe", "Smoke endpoint must be an IP-literal loopback HTTP URL.");
        }
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var deadline = DateTimeOffset.UtcNow.AddMilliseconds(restart.HealthTimeoutMs);
        Exception? lastError = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            try
            {
                using var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead);
                if (response.IsSuccessStatusCode)
                {
                    journal.Append("smoke_passed", new { statusCode = (int)response.StatusCode });
                    return;
                }
                lastError = new HttpRequestException($"Health returned {(int)response.StatusCode}.");
            }
            catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
            {
                lastError = error;
            }
            await Task.Delay(500);
        }
        throw new HelperException("smoke_failed", lastError?.Message ?? "Runtime health did not become ready.");
    }

    private static void WriteResult(
        HelperRequest request,
        string requestSha256,
        string status,
        string? baselineSha,
        string? baselineTree,
        string? failureCode,
        DurableJournal journal)
    {
        var finishedAt = DateTimeOffset.UtcNow.ToString("O");
        var evidenceSha256 = Sha256(Encoding.UTF8.GetBytes(string.Join("|", request.Operation, request.ManifestId, status, baselineSha, baselineTree, failureCode, finishedAt)));
        var result = new HelperResult(1, request.Operation, request.ManifestId, requestSha256, status, baselineSha, baselineTree, failureCode, evidenceSha256, finishedAt);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(result, JsonOptions);
        try
        {
            using var stream = new FileStream(request.ResultPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
            stream.Write(bytes);
            stream.Flush(flushToDisk: true);
        }
        catch (IOException)
        {
            var existing = File.ReadAllBytes(request.ResultPath);
            if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(existing), SHA256.HashData(bytes)))
            {
                throw new HelperException("result_immutability_conflict", "Helper result path already contains different bytes.");
            }
        }
        journal.Append("result_published", new { status, evidenceSha256 });
    }

    private static string Git(string sourceRoot, params string[] args) => RunGit(sourceRoot, mutable: false, args);

    private static string GitMutable(string sourceRoot, params string[] args) => RunGit(sourceRoot, mutable: true, args);

    private static string RunGit(string sourceRoot, bool mutable, params string[] args)
    {
        var info = new ProcessStartInfo
        {
            FileName = "git.exe",
            WorkingDirectory = sourceRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        info.Environment["GIT_TERMINAL_PROMPT"] = "0";
        info.Environment["GIT_OPTIONAL_LOCKS"] = mutable ? "1" : "0";
        info.ArgumentList.Add("-C");
        info.ArgumentList.Add(sourceRoot);
        if (mutable)
        {
            info.ArgumentList.Add("-c");
            info.ArgumentList.Add("core.hooksPath=NUL");
        }
        foreach (var arg in args) info.ArgumentList.Add(arg);
        using var process = Process.Start(info) ?? throw new HelperException("git_launch_failed", "Git process did not start.");
        var stdoutTask = ReadBoundedProcessStreamAsync(process.StandardOutput, MaxProcessOutputBytes);
        var stderrTask = ReadBoundedProcessStreamAsync(process.StandardError, MaxProcessOutputBytes);
        if (!process.WaitForExit(10 * 60_000))
        {
            process.Kill(entireProcessTree: true);
            throw new HelperException("git_timeout", "Git operation exceeded its bounded timeout.");
        }
        Task.WaitAll(stdoutTask, stderrTask);
        if (process.ExitCode != 0)
        {
            throw new HelperException("git_operation_failed", $"Git exited {process.ExitCode}: {SanitizeDiagnostic(stderrTask.Result)}");
        }
        return stdoutTask.Result.Trim();
    }

    private static async Task<string> ReadBoundedProcessStreamAsync(StreamReader reader, int maxBytes)
    {
        var buffer = new char[4096];
        var output = new StringBuilder();
        while (true)
        {
            var count = await reader.ReadAsync(buffer);
            if (count == 0) return output.ToString();
            output.Append(buffer, 0, count);
            if (Encoding.UTF8.GetByteCount(output.ToString()) > maxBytes)
            {
                throw new HelperException("process_output_limit", "Child process output exceeded its bound.");
            }
        }
    }

    private static void ValidateRequest(HelperRequest request, string requestDirectory)
    {
        if (request.SchemaVersion != 1 || request.Operation is not ("apply" or "rollback")) throw ContractError();
        RequireIdentifier(request.PlanId, "planId");
        RequireIdentifier(request.ManifestId, "manifestId");
        RequireIdentifier(request.InstallId, "installId");
        RequireSha256(request.ManifestSha256, "manifestSha256");
        RequireSha256(request.PatchSha256, "patchSha256");
        RequireSha256(request.CompensationSha256, "compensationSha256");
        RequireGitObject(request.ExpectedHead);
        RequireGitObject(request.ExpectedTree);
        if (
            request.InstallRevision < 1
            || request.ParentPid < 1
            || request.ParentStartedAtUnixMs < 1
            || request.ChangedFiles.Count is < 1 or > 2000
            || request.ApprovalIds.Count < 1
        ) throw ContractError();
        if (request.ChangedFiles.Any(file => file.ChangeKind == "renamed"))
        {
            throw new HelperException("rename_not_supported", "Live source apply v1 does not accept renamed paths.");
        }
        foreach (var approvalId in request.ApprovalIds) RequireIdentifier(approvalId, "approvalId");
        request.SourceRoot = CanonicalDirectory(request.SourceRoot, "sourceRoot");
        request.PatchPath = CanonicalFile(request.PatchPath, "patchPath");
        request.CompensationPath = CanonicalFile(request.CompensationPath, "compensationPath");
        request.ResultPath = CanonicalProspectiveFile(request.ResultPath, "resultPath");
        request.JournalPath = CanonicalProspectiveFile(request.JournalPath, "journalPath");
        if (
            !string.Equals(Path.GetDirectoryName(request.ResultPath), requestDirectory, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(Path.GetDirectoryName(request.JournalPath), requestDirectory, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(Path.GetDirectoryName(request.PatchPath), requestDirectory, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(Path.GetDirectoryName(request.CompensationPath), requestDirectory, StringComparison.OrdinalIgnoreCase))
        {
            throw new HelperException("artifact_jail_mismatch", "All helper artifacts must stay inside the immutable request directory.");
        }
        if (!DateTimeOffset.TryParse(request.CreatedAt, out _)) throw ContractError();
        ValidateRestart(request.Restart);
    }

    private static void ValidateRestart(RestartDescriptor restart)
    {
        restart.Executable = CanonicalFile(restart.Executable, "restart executable");
        restart.WorkingDirectory = CanonicalDirectory(restart.WorkingDirectory, "restart working directory");
        if (restart.Args.Count > 64 || restart.Args.Any(arg => string.IsNullOrEmpty(arg) || arg.Length > 4096 || arg.IndexOfAny(['\0', '\r', '\n']) >= 0)) throw ContractError();
        if (restart.HealthTimeoutMs is < 5000 or > 600000) throw ContractError();
        if (!Uri.TryCreate(restart.HealthUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttp || !IPAddress.TryParse(uri.Host, out var ip) || !IPAddress.IsLoopback(ip))
        {
            throw new HelperException("smoke_url_unsafe", "Restart health URL must be IP-literal loopback HTTP.");
        }
    }

    private static ParsedArguments ParseArguments(string[] args)
    {
        string? request = null;
        string? requestSha256 = null;
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index] == "--request" && index + 1 < args.Length) request = args[++index];
            else if (args[index] == "--request-sha256" && index + 1 < args.Length) requestSha256 = args[++index];
            else throw new HelperException("arguments_invalid", "Only --request and --request-sha256 are accepted.");
        }
        if (request is null || requestSha256 is null) throw new HelperException("arguments_invalid", "Request path and hash are required.");
        RequireSha256(requestSha256, "requestSha256");
        return new ParsedArguments(request, requestSha256.ToLowerInvariant());
    }

    private static string CanonicalFile(string value, string label)
    {
        var full = Path.GetFullPath(RequirePath(value, label));
        RequireRegularFile(full, label);
        return full;
    }

    private static string CanonicalProspectiveFile(string value, string label)
    {
        var full = Path.GetFullPath(RequirePath(value, label));
        var directory = Path.GetDirectoryName(full) ?? throw new HelperException("path_invalid", $"{label} has no directory.");
        CanonicalDirectory(directory, $"{label} directory");
        if (File.Exists(full)) RequireRegularFile(full, label);
        return full;
    }

    private static string CanonicalDirectory(string value, string label)
    {
        var full = Path.GetFullPath(RequirePath(value, label)).TrimEnd(Path.DirectorySeparatorChar);
        RequireRegularDirectory(full, label);
        return full;
    }

    private static string RequirePath(string value, string label)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 4096 || value.IndexOfAny(['\0', '\r', '\n']) >= 0 || !Path.IsPathFullyQualified(value))
        {
            throw new HelperException("path_invalid", $"{label} is invalid.");
        }
        return value;
    }

    private static void RequireRegularFile(string target, string label)
    {
        var info = new FileInfo(target);
        if (!info.Exists || info.Attributes.HasFlag(FileAttributes.ReparsePoint))
        {
            throw new HelperException("path_unsafe", $"{label} is missing or reparse-backed.");
        }
    }

    private static void RequireRegularDirectory(string target, string label)
    {
        var info = new DirectoryInfo(target);
        if (!info.Exists || info.Attributes.HasFlag(FileAttributes.ReparsePoint))
        {
            throw new HelperException("path_unsafe", $"{label} is missing or reparse-backed.");
        }
    }

    private static void AssertNoReparsePath(string target, bool includeLeaf)
    {
        var full = Path.GetFullPath(target);
        var root = Path.GetPathRoot(full) ?? throw new HelperException("path_invalid", "Path has no volume root.");
        var relative = Path.GetRelativePath(root, full);
        var parts = relative.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        var count = includeLeaf ? parts.Length : Math.Max(0, parts.Length - 1);
        var cursor = root;
        for (var index = 0; index < count; index++)
        {
            cursor = Path.Join(cursor, parts[index]);
            var attributes = File.GetAttributes(cursor);
            if (attributes.HasFlag(FileAttributes.ReparsePoint))
            {
                throw new HelperException("path_reparse_unsafe", "Path ancestry crosses a reparse point.");
            }
        }
    }

    private static string JoinRelative(string root, string relative)
    {
        AssertSafeRelativePath(relative);
        var full = Path.GetFullPath(Path.Join(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        var fromRoot = Path.GetRelativePath(root, full);
        if (fromRoot.StartsWith("..", StringComparison.Ordinal) || Path.IsPathFullyQualified(fromRoot)) throw new HelperException("path_escape", "Changed path escapes source root.");
        return full;
    }

    private static void AssertSafeRelativePath(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 2048 || Path.IsPathFullyQualified(value) || value.StartsWith('/') || value.Split('/').Any(part => part is "" or "." or ".."))
        {
            throw new HelperException("relative_path_invalid", "Changed path is unsafe.");
        }
    }

    private static async Task<byte[]> ReadBoundedAsync(string target, int maxBytes)
    {
        var info = new FileInfo(target);
        if (info.Length > maxBytes) throw new HelperException("request_too_large", "Request exceeds its size bound.");
        return await File.ReadAllBytesAsync(target);
    }

    private static string RequireIdentifier(string value, string label)
    {
        if (string.IsNullOrWhiteSpace(value) || !IdentifierRegex().IsMatch(value)) throw new HelperException("request_contract_invalid", $"{label} is invalid.");
        return value;
    }

    private static string RequireGitObject(string value)
    {
        if (!GitObjectRegex().IsMatch(value)) throw ContractError();
        return value.ToLowerInvariant();
    }

    private static void RequireSha256(string value, string label)
    {
        if (!Sha256Regex().IsMatch(value)) throw new HelperException("request_contract_invalid", $"{label} is invalid.");
    }

    private static bool FixedEquals(string left, string right)
    {
        if (!Sha256Regex().IsMatch(left) || !Sha256Regex().IsMatch(right)) return false;
        return CryptographicOperations.FixedTimeEquals(Convert.FromHexString(left), Convert.FromHexString(right));
    }

    private static string Sha256(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();

    private static string FailureCode(Exception error) => error is HelperException helper ? helper.Code : "native_helper_failed";

    private static string SanitizeDiagnostic(string value)
    {
        var normalized = value.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return normalized.Length <= 512 ? normalized : normalized[..512];
    }

    private static HelperException ContractError() => new("request_contract_invalid", "Helper request failed contract validation.");

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$", RegexOptions.CultureInvariant)]
    private static partial Regex IdentifierRegex();

    [GeneratedRegex("^[a-fA-F0-9]{40,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex GitObjectRegex();

    [GeneratedRegex("^[a-fA-F0-9]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Regex();
}

internal sealed class DurableJournal
{
    private readonly string _path;
    private readonly string _manifestId;

    public DurableJournal(string path, string manifestId)
    {
        _path = path;
        _manifestId = manifestId;
    }

    public void Append(string eventType, object payload)
    {
        var record = JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            manifestId = _manifestId,
            eventType,
            payload,
            createdAt = DateTimeOffset.UtcNow.ToString("O"),
        });
        using var stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
        using var writer = new StreamWriter(stream, new UTF8Encoding(false), leaveOpen: true);
        writer.WriteLine(record);
        writer.Flush();
        stream.Flush(flushToDisk: true);
    }
}

internal sealed class HelperException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal sealed record ParsedArguments(string RequestPath, string RequestSha256);

internal sealed class HelperRequest
{
    public int SchemaVersion { get; init; }
    public string Operation { get; init; } = "";
    public string PlanId { get; init; } = "";
    public string ManifestId { get; init; } = "";
    public string ManifestSha256 { get; init; } = "";
    public string InstallId { get; init; } = "";
    public long InstallRevision { get; init; }
    public string SourceRoot { get; set; } = "";
    public string ExpectedHead { get; init; } = "";
    public string ExpectedTree { get; init; } = "";
    public string PatchPath { get; set; } = "";
    public string PatchSha256 { get; init; } = "";
    public string CompensationPath { get; set; } = "";
    public string CompensationSha256 { get; init; } = "";
    public List<ChangedFile> ChangedFiles { get; init; } = [];
    public List<string> ApprovalIds { get; init; } = [];
    public int ParentPid { get; init; }
    public long ParentStartedAtUnixMs { get; init; }
    public RestartDescriptor Restart { get; init; } = new();
    public string ResultPath { get; set; } = "";
    public string JournalPath { get; set; } = "";
    public string CreatedAt { get; init; } = "";
}

internal sealed class ChangedFile
{
    public string Path { get; init; } = "";
    public string ChangeKind { get; init; } = "";
    public string? BeforeSha256 { get; init; }
    public string? AfterSha256 { get; init; }
}

internal sealed class RestartDescriptor
{
    public string Executable { get; set; } = "";
    public List<string> Args { get; init; } = [];
    public string WorkingDirectory { get; set; } = "";
    public string HealthUrl { get; init; } = "";
    public int HealthTimeoutMs { get; init; }
}

internal sealed record HelperResult(
    int SchemaVersion,
    string Operation,
    string ManifestId,
    string RequestSha256,
    string Status,
    string? BaselineSha,
    string? BaselineTree,
    string? FailureCode,
    string EvidenceSha256,
    string FinishedAt
);
