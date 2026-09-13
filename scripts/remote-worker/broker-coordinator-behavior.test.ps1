#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$RepositoryRoot,
  [Parameter(Mandatory = $true)][string]$ArtifactRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Exercise the actual filesystem helpers and recipe functions in a task-owned
# temporary tree. No recipe main, service operation or installed path is run.
$artifactPath = [System.IO.Path]::GetFullPath($ArtifactRoot)
$tempPath = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\") + "\"
if (-not $artifactPath.StartsWith($tempPath, [System.StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $artifactPath)) {
  throw "A fresh test directory below the system temporary directory is required."
}
[void][System.IO.Directory]::CreateDirectory($artifactPath)
$recipeRoot = Join-Path $RepositoryRoot "scripts\remote-worker"
. (Join-Path $recipeRoot "broker-coordinator-common.ps1")
Initialize-BrokerCoordinatorNativeType
$native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
$outcomes = New-Object System.Collections.Generic.List[string]

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-Throws {
  param([scriptblock]$Action)
  $threw = $false
  try { & $Action } catch { $threw = $true }
  Assert-True $threw "Expected the operation to refuse."
}

function Invoke-Case {
  param([string]$Name, [scriptblock]$Action)
  try { & $Action; $outcomes.Add($Name) }
  catch {
    [Console]::Error.WriteLine($_.ScriptStackTrace)
    throw ("Case '{0}' failed: {1}" -f $Name, $_.Exception.Message)
  }
}

function Import-RecipeFunctions {
  param([string]$Name)
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $recipeRoot $Name), [ref]$tokens, [ref]$errors)
  Assert-True ($errors.Count -eq 0) "Recipe failed to parse."
  $definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
  foreach ($definition in $definitions) {
    # Return only the function declarations, never the installer entrypoint.
    $definition.Extent.Text
  }
}

function Reset-PinCase {
  $script:Pins = $null
  $script:Refusals = New-Object System.Collections.Generic.List[string]
  $script:BrokerImageSha256 = $null
  $script:SignerImageSha256 = $null
  $script:ClientImageSha256 = $null
}

foreach ($definition in (Import-RecipeFunctions "install-broker-coordinator.ps1")) {
  . ([scriptblock]::Create($definition))
}
$Preflight = $true
$Target = "windows-x64"
$PackageResultPath = Join-Path $artifactPath "package-result.json"
$brokerHash = "1" * 64
$signerHash = "2" * 64
$clientHash = "3" * 64
$goodManifest = @{
  target = $Target
  availability = @{ sha256 = $brokerHash; targetServiceSha256 = $signerHash }
  service = @{ sha256 = $signerHash; targetClientSha256 = $clientHash }
  client = @{ sha256 = $clientHash }
} | ConvertTo-Json -Depth 5

Invoke-Case "package-pins-bind-the-complete-trio" {
  Reset-PinCase
  [System.IO.File]::WriteAllText($PackageResultPath, $goodManifest)
  Resolve-RecipePins
  Assert-True ($script:Refusals.Count -eq 0) "Valid trio was refused."
  Assert-True ($script:Pins.clientImageSha256 -ceq $clientHash -and $script:Pins.packageTargetClientSha256Consistent) "Client pin was not retained."
}

Invoke-Case "install-step-reports-collected-refusals" {
  $script:Steps = New-Object System.Collections.Generic.List[object]
  $script:Refusals.Clear()
  Invoke-RecipeStep -Name "fixture-refusal" -Body { Add-RefusalFinding "expected refusal" }
  Invoke-RecipeStep -Name "fixture-pass" -Body { "passed detail" }
  Assert-True ($script:Steps[0].status -ceq "refused" -and $script:Steps[0].detail -ceq "expected refusal") "A refused preflight step was labeled passed."
  Assert-True ($script:Steps[1].status -ceq "passed") "A later passing step inherited an earlier refusal."
}

foreach ($mode in @("missing-client", "missing-client-binding", "client-binding-drift", "signer-binding-drift", "wrong-target", "malformed-sha", "conflicting-client", "null-manifest", "array-manifest", "invalid-json")) {
  Invoke-Case ("package-refuses-" + $mode) {
    Reset-PinCase
    $manifest = $goodManifest | ConvertFrom-Json
    switch ($mode) {
      "missing-client" { $manifest.PSObject.Properties.Remove("client") }
      "missing-client-binding" { $manifest.service.PSObject.Properties.Remove("targetClientSha256") }
      "client-binding-drift" { $manifest.service.targetClientSha256 = "4" * 64 }
      "signer-binding-drift" { $manifest.availability.targetServiceSha256 = "4" * 64 }
      "wrong-target" { $manifest.target = "windows-arm64" }
      "malformed-sha" { $manifest.client.sha256 = "invalid" }
      "conflicting-client" { $script:ClientImageSha256 = "4" * 64 }
    }
    $json = $manifest | ConvertTo-Json -Depth 5
    if ($mode -eq "null-manifest") { $json = "null" }
    if ($mode -eq "array-manifest") { $json = "[]" }
    if ($mode -eq "invalid-json") { $json = "{" }
    [System.IO.File]::WriteAllText($PackageResultPath, $json)
    Resolve-RecipePins
    Assert-True ($script:Refusals.Count -gt 0) "Invalid package was accepted."
  }
}

Invoke-Case "package-result-size-is-bounded" {
  Reset-PinCase
  $stream = [System.IO.File]::Open($PackageResultPath, "Create", "Write", "None")
  try { $stream.SetLength(2097153) } finally { $stream.Dispose() }
  Resolve-RecipePins
  Assert-True (($script:Refusals -join " ") -match "2 MiB limit") "Oversize manifest was not refused before parsing."
}

Invoke-Case "explicit-pins-require-the-client" {
  Reset-PinCase
  $PackageResultPath = $null
  $script:BrokerImageSha256 = $brokerHash
  $script:SignerImageSha256 = $signerHash
  Resolve-RecipePins
  Assert-True ($script:Refusals.Count -gt 0 -and $null -eq $script:Pins) "Two pins were sufficient."
  $script:ClientImageSha256 = $clientHash
  $script:Refusals.Clear()
  Resolve-RecipePins
  Assert-True ($script:Refusals.Count -eq 0 -and $script:Pins.clientImageSha256 -eq $clientHash) "Explicit trio was refused."
}

Invoke-Case "ancestor-owner-and-effective-write-policy" {
  Assert-BrokerCoordinatorAncestorSddl -Sddl $script:SharedRootSddl -GoatCitadelLevel
  Assert-BrokerCoordinatorAncestorSddl -Sddl "O:SYD:P(A;;FA;;;SY)(A;;FRFX;;;WD)" -GoatCitadelLevel
  Assert-BrokerCoordinatorAncestorSddl -Sddl "O:SYD:P(A;IOCI;FA;;;WD)" -GoatCitadelLevel
  Assert-Throws { Assert-BrokerCoordinatorAncestorSddl -Sddl "O:BAD:P(A;;FA;;;BA)" -GoatCitadelLevel }
  foreach ($mask in @("0x00000040", "0x00040000", "0x00080000", "0x40000000", "0x10000000", "0x00000002", "0x00010000")) {
    Assert-Throws { Assert-BrokerCoordinatorAncestorSddl -Sddl ("O:SYD:P(A;;" + $mask + ";;;WD)") -GoatCitadelLevel }
  }
}

$operatorSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$testSddl = "O:" + $operatorSid + "D:P(A;;FA;;;" + $operatorSid + ")"
$nativeDirectory = Join-Path $artifactPath "native-directory"
Invoke-Case "win32-directory-creation-is-exclusive-and-protected" {
  $native::CreateProtectedDirectory($nativeDirectory, $testSddl)
  Assert-True ($native::GetFileSddl($nativeDirectory) -ceq $native::CanonicalizeSddl($testSddl)) "Creation did not apply the descriptor."
  [System.IO.File]::WriteAllText((Join-Path $nativeDirectory "preserved.txt"), "preserve")
  Assert-Throws { $native::CreateProtectedDirectory($nativeDirectory, $testSddl) }
  Assert-True ([System.IO.File]::ReadAllText((Join-Path $nativeDirectory "preserved.txt")) -ceq "preserve") "Exclusive creation changed existing content."
}

Invoke-Case "directory-lease-refuses-replacement-and-releases" {
  $lease = $native::PinDirectory($nativeDirectory)
  $moved = $nativeDirectory + "-moved"
  try { Assert-Throws { [System.IO.Directory]::Move($nativeDirectory, $moved) } }
  finally { $lease.Dispose() }
  [System.IO.Directory]::Move($nativeDirectory, $moved)
  Assert-True (Test-Path -LiteralPath (Join-Path $moved "preserved.txt")) "Directory remained pinned after disposal."
}

Invoke-Case "directory-lease-refuses-junctions-and-aliased-children" {
  $realDirectory = Join-Path $artifactPath "real-directory"
  $aliasDirectory = Join-Path $artifactPath "alias-directory"
  [void][System.IO.Directory]::CreateDirectory((Join-Path $realDirectory "child"))
  New-Item -ItemType Junction -Path $aliasDirectory -Target $realDirectory | Out-Null
  Assert-Throws { $lease = $native::PinDirectory($aliasDirectory); $lease.Dispose() }
  Assert-Throws { $lease = $native::PinDirectory((Join-Path $aliasDirectory "child")); $lease.Dispose() }
}

$script:CopiedFiles = New-Object System.Collections.Generic.List[string]
$script:CreatedDirectories = New-Object System.Collections.Generic.List[string]
$script:CreatedServices = New-Object System.Collections.Generic.List[string]
$script:CleanupFailures = New-Object System.Collections.Generic.List[string]
$script:DirectoryLeases = New-Object System.Collections.Generic.List[System.IDisposable]
$script:ImageLeases = New-Object System.Collections.Generic.List[System.IDisposable]
Invoke-Case "staging-refuses-a-root-planted-after-preflight" {
  $raceRoot = Join-Path $artifactPath "raced-root"
  [void][System.IO.Directory]::CreateDirectory($raceRoot)
  [System.IO.File]::WriteAllText((Join-Path $raceRoot "preserved.txt"), "preserve")
  $script:Paths = [pscustomobject]@{
    GoatCitadelDirectory = $raceRoot
    ProvisionerDirectory = Join-Path $raceRoot "RemoteWorkerProvisioner"
    BinDirectory = Join-Path $raceRoot "RemoteWorkerProvisioner\bin"
  }
  $script:GoatCitadelRootWasPresent = $false
  $savedSddl = $script:SharedRootSddl
  try {
    $script:SharedRootSddl = $testSddl
    Assert-Throws { New-RecipeInstallDirectories }
  }
  finally { $script:SharedRootSddl = $savedSddl }
  Assert-True ($script:CreatedDirectories.Count -eq 0) "Staging adopted the raced root."
  Assert-True (-not (Test-Path -LiteralPath $script:Paths.ProvisionerDirectory)) "Staging created a child in the raced root."
  Assert-True ([System.IO.File]::ReadAllText((Join-Path $raceRoot "preserved.txt")) -ceq "preserve") "Staging changed the raced root."
}

$source = Join-Path $artifactPath "source.bin"
$destination = Join-Path $artifactPath "copied.bin"
[System.IO.File]::WriteAllText($source, "bounded image fixture")

Invoke-Case "staged-image-accepts-one-unnamed-data-stream" {
  $script:Refusals.Clear()
  Test-RecipeStagedImage -Path $source -ExpectedSha256 (Get-BrokerCoordinatorFileSha256 $source) -Description "fixture"
  Assert-True ($script:Refusals.Count -eq 0) "Regular staged image was refused."
  $streams = Get-BrokerCoordinatorStreamNames -Path $source
  Assert-True ($streams.Count -eq 1 -and $streams[0] -ceq ':$DATA') "The single stream lost its array shape."
}

Invoke-Case "staged-image-refuses-extra-streams-and-hard-links" {
  Set-Content -LiteralPath $source -Stream "fixture" -Value "alternate stream fixture"
  try {
    $script:Refusals.Clear()
    Test-RecipeStagedImage -Path $source -ExpectedSha256 (Get-BrokerCoordinatorFileSha256 $source) -Description "fixture"
    Assert-True (($script:Refusals -join " ") -match "alternate data streams") "Alternate stream was accepted."
  }
  finally { Remove-Item -LiteralPath $source -Stream "fixture" }
  $alias = Join-Path $artifactPath "source-hardlink.bin"
  New-Item -ItemType HardLink -Path $alias -Target $source | Out-Null
  try {
    $script:Refusals.Clear()
    Test-RecipeStagedImage -Path $source -ExpectedSha256 (Get-BrokerCoordinatorFileSha256 $source) -Description "fixture"
    Assert-True (($script:Refusals -join " ") -match "exactly one hard link") "Hard-linked staged image was accepted."
  }
  finally { Remove-Item -LiteralPath $alias }
}

Invoke-Case "copy-preserves-bytes-and-holds-image-against-writers" {
  Copy-RecipePinnedImage -Source $source -Destination $destination -Sddl $testSddl
  Assert-True ((Get-BrokerCoordinatorFileSha256 $source) -ceq (Get-BrokerCoordinatorFileSha256 $destination)) "Copy changed the bytes."
  Assert-True ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($destination))) -ceq (ConvertTo-CanonicalFileSddl $testSddl)) "Copy did not apply its descriptor."
  Assert-True ((ConvertTo-CanonicalFileSddl $script:ClientImageSddl) -cne (ConvertTo-CanonicalFileSddl $testSddl)) "File descriptor comparison ignored the owner or ACEs."
  Assert-Throws { $writer = [System.IO.File]::Open($destination, "Open", "Write", "ReadWrite"); $writer.Dispose() }
  Close-RecipeLeases
  $writer = [System.IO.File]::Open($destination, "Open", "Write", "ReadWrite")
  $writer.Dispose()
}

Invoke-Case "signer-and-broker-have-distinct-worker-authority" {
  $signer = New-Object System.Security.AccessControl.RawSecurityDescriptor($script:SignerServiceObjectSddl)
  $broker = New-Object System.Security.AccessControl.RawSecurityDescriptor($script:ServiceObjectSddl)
  Assert-True ($signer.Owner.Value -ceq 'S-1-5-18' -and $broker.Owner.Value -ceq 'S-1-5-18') "Service owner drifted."
  Assert-True ($signer.DiscretionaryAcl.Count -eq 3 -and $broker.DiscretionaryAcl.Count -eq 2) "Service principals changed."
  $query = $signer.DiscretionaryAcl[2]
  Assert-True ($query.SecurityIdentifier.Value -ceq $script:RuntimeWorkerServiceSid -and $query.AccessMask -eq 0x00020005 -and [int]$query.AceFlags -eq 0 -and [int]$query.AceType -eq 0) "Worker signer query authority changed."
  for ($index = 0; $index -lt $broker.DiscretionaryAcl.Count; $index++) {
    Assert-True ($broker.DiscretionaryAcl[$index].SecurityIdentifier.Value -cne $script:RuntimeWorkerServiceSid) "Worker gained broker access."
  }
}

Invoke-Case "copied-image-retains-exact-worker-read-execute-ace" {
  # Substitute only SYSTEM ownership/control with the current test user.
  # The production SYSTEM-owned installation remains an elevated proof gate.
  $fixtureSddl = $script:ClientImageSddl.Replace('O:SY', ('O:' + $operatorSid)).Replace(';;;SY)', (';;;' + $operatorSid + ')'))
  $workerImage = Join-Path $artifactPath "worker-readable.bin"
  Copy-RecipePinnedImage -Source $source -Destination $workerImage -Sddl $fixtureSddl
  try {
    $readBack = $native::GetFileSddl($workerImage)
    Assert-True ((ConvertTo-CanonicalFileSddl $readBack) -ceq (ConvertTo-CanonicalFileSddl $fixtureSddl)) "Image descriptor changed on disk."
    $descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($readBack)
    Assert-True ($descriptor.DiscretionaryAcl.Count -eq 4) "Image gained or lost an ACE."
    $workerAce = $descriptor.DiscretionaryAcl[3]
    Assert-True ($workerAce.SecurityIdentifier.Value -ceq $script:RuntimeWorkerServiceSid -and $workerAce.AccessMask -eq 0x001200a9 -and [int]$workerAce.AceFlags -eq 0 -and [int]$workerAce.AceType -eq 0) "Worker image access is not exact non-inherited read/execute."
    Assert-True ((Get-BrokerCoordinatorFileSha256 $workerImage) -ceq (Get-BrokerCoordinatorFileSha256 $source)) "Worker image bytes changed."
  } finally { Close-RecipeLeases }
}

$existing = Join-Path $artifactPath "unowned.bin"
[System.IO.File]::WriteAllText($existing, "preserve")
Invoke-Case "copy-refuses-an-existing-destination" {
  $priorCount = $script:CopiedFiles.Count
  Assert-Throws { Copy-RecipePinnedImage -Source $source -Destination $existing -Sddl $testSddl }
  Assert-True ([System.IO.File]::ReadAllText($existing) -ceq "preserve" -and $script:CopiedFiles.Count -eq $priorCount) "Existing bytes were overwritten or claimed."
}

Invoke-Case "copy-refuses-an-open-source-writer" {
  $writer = [System.IO.File]::Open($source, "Open", "Write", "ReadWrite")
  $refused = Join-Path $artifactPath "writer-refused.bin"
  try { Assert-Throws { Copy-RecipePinnedImage -Source $source -Destination $refused -Sddl $testSddl } }
  finally { $writer.Dispose() }
  Assert-True (-not (Test-Path -LiteralPath $refused)) "A destination was created from a writable source."
}

Invoke-Case "copy-enforces-its-size-bound-before-creation" {
  $script:MaximumImageBytes = 4
  $refused = Join-Path $artifactPath "size-refused.bin"
  try { Assert-Throws { Copy-RecipePinnedImage -Source $source -Destination $refused -Sddl $testSddl } }
  finally { $script:MaximumImageBytes = 67108864 }
  Assert-True (-not (Test-Path -LiteralPath $refused)) "Oversize source created a destination."
}

Invoke-Case "partial-copy-is-owned-by-rollback-and-unrelated-file-survives" {
  $partial = Join-Path $artifactPath "partial.bin"
  Assert-Throws { Copy-RecipePinnedImage -Source $source -Destination $partial -Sddl "invalid" }
  Assert-True ($script:CopiedFiles -contains $partial -and (Test-Path -LiteralPath $partial)) "Partial copy was lost from rollback ownership."
  foreach ($ownedFile in $script:CopiedFiles) {
    Assert-True ([System.IO.Path]::GetFullPath($ownedFile).StartsWith($artifactPath + "\", [System.StringComparison]::OrdinalIgnoreCase)) "Rollback target escaped the test directory."
  }
  # The fixture's owner is the current user. SYSTEM ACL application and SCM
  # lifecycle remain installed-host acceptance, not a claim made by this test.
  $script:UninstallRestoreSddl = $testSddl
  Invoke-RecipeRollback
  Assert-True (-not (Test-Path -LiteralPath $partial)) "Rollback left its partial copy."
  Assert-True (-not (Test-Path -LiteralPath $destination)) "Rollback left its completed copy."
  Assert-True ([System.IO.File]::ReadAllText($existing) -ceq "preserve") "Rollback touched an unrelated file."
}

foreach ($definition in (Import-RecipeFunctions "uninstall-broker-coordinator.ps1")) {
  . ([scriptblock]::Create($definition))
}
$script:Paths = [pscustomobject]@{ ClientImagePath = $source }
Invoke-Case "uninstall-step-reports-collected-refusals" {
  $script:Steps = New-Object System.Collections.Generic.List[object]
  $script:Refusals.Clear()
  Invoke-RecipeStep -Name "fixture-refusal" -Body { Add-RefusalFinding "expected refusal" }
  Assert-True ($script:Steps[0].status -ceq "refused" -and $script:Steps[0].detail -ceq "expected refusal") "A refused uninstall step was labeled passed."
}

Invoke-Case "uninstall-client-refuses-missing-pin-drift-and-wrong-acl" {
  $Preflight = $true
  $script:ClientImageSha256 = $null
  $script:Refusals.Clear()
  Test-RecipeClientIdentity
  Assert-True (($script:Refusals -join " ") -match "requires -ClientImageSha256") "Uninstall accepted an unpinned client."
  $script:ClientImageSha256 = "4" * 64
  $script:Refusals.Clear()
  Test-RecipeClientIdentity
  Assert-True (($script:Refusals -join " ") -match "hash does not match") "Uninstall accepted client drift."
  $script:ClientImageSha256 = Get-BrokerCoordinatorFileSha256 $source
  $script:Refusals.Clear()
  Test-RecipeClientIdentity
  Assert-True (($script:Refusals -join " ") -match "security descriptor has drifted") "Uninstall accepted a user-owned client."
  Assert-True (Test-Path -LiteralPath $source) "Read-only uninstall identity check changed its input."
}

$receipt = [ordered]@{
  schema = "goatcitadel.remote-worker.broker-coordinator-behavior/1"
  powershell = $PSVersionTable.PSVersion.ToString()
  passed = $true
  scenarios = $outcomes.ToArray()
  scenarioCount = $outcomes.Count
  serviceMutations = 0
  installedPathMutations = 0
  boundary = "Real Win32 and temporary-file behavior; SYSTEM-owned installed service lifecycle remains unproven."
}
$json = $receipt | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $artifactPath "behavior-receipt.json"), $json)
Write-Output $json
