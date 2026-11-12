import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
  canonicalJsonString,
  ConflictError,
  type ManagedProjectFilePublishRequest,
  type ManagedProjectFilePublishResult,
  type ManagedProjectFileRevision,
  type ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { assertToolWritePath } from "@goatcitadel/policy-engine";
import {
  captureGovernedFileEntry,
  GovernedFileHandlePortRefusalError,
  isGovernedFileHandlePortAvailable,
  overwriteGovernedFileEntry,
  publishGovernedFileEntry,
} from "./governed-file-windows-handle-port.js";

const nativeFiles = {
  available: isGovernedFileHandlePortAvailable,
  capture: captureGovernedFileEntry,
  create: publishGovernedFileEntry,
  overwrite: overwriteGovernedFileEntry,
};

const reviewLifetimeMs = 5 * 60_000;
export const managedPublishReviewPattern = /^\d{13}\.[a-f0-9]{64}$/u;

export function createManagedProjectPublisher(getSandbox: () => ToolPolicyConfig["sandbox"], files = nativeFiles) {
  const signingKey = randomBytes(32);
  return {
    available: files.available,
    async publish(input: {
      request: ManagedProjectFilePublishRequest;
      file: ManagedProjectFileRevision;
      content: Buffer;
      projectRoot: string;
      sessionId: string;
      actorId: string;
      revalidatePolicy(): Promise<void>;
    }): Promise<ManagedProjectFilePublishResult> {
      const { request, file, content, sessionId, actorId } = input;
      const projectRoot = input.projectRoot.replace(/^[a-z]:/u, (drive) => drive.toUpperCase());
      if (!files.available()) throw new ConflictError({ message: "Publishing managed files requires Windows." });
      if (projectRoot.split(/[\\/]/u).some((part) => part.toLowerCase() === ".git")) {
        throw new ConflictError({ message: "Publishing cannot target Git metadata." });
      }
      const destination = path.join(projectRoot, file.path);
      assertToolWritePath(destination, getSandbox());
      const current = await files.capture(projectRoot, file.path);
      try {
        if (current.present) {
          const signature = (expiry: string) =>
            createHmac("sha256", signingKey)
              .update(
                canonicalJsonString([
                  expiry,
                  sessionId,
                  actorId,
                  file.workspaceId,
                  file.projectId,
                  request.expectedModeRevision,
                  file.revisionId,
                  file.contentSha256,
                  current.rootPath,
                  current.relativePath,
                  current.parent.volumeSerial,
                  current.parent.fileId,
                  current.entry,
                  current.sha256,
                ]),
              )
              .digest("hex");
          if (!request.overwriteRevision) {
            const expiry = String(Date.now() + reviewLifetimeMs);
            return {
              status: "overwrite_required",
              path: file.path,
              overwriteRevision: expiry + "." + signature(expiry),
            };
          }
          const [expiry, digest] = request.overwriteRevision.split(".");
          if (
            !expiry ||
            !digest ||
            !managedPublishReviewPattern.test(request.overwriteRevision) ||
            Number(expiry) < Date.now() ||
            !timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(signature(expiry), "hex"))
          )
            throw destinationChanged();
        } else if (request.overwriteRevision) {
          throw destinationChanged();
        }

        await input.revalidatePolicy();
        assertToolWritePath(destination, getSandbox());
        let contentSha256: string;
        try {
          contentSha256 = current.present
            ? await files.overwrite(current, content)
            : (
                await files.create({
                  rootPath: current.rootPath,
                  relativePath: current.relativePath,
                  expectedParent: current.parent,
                  expectedPrior: { present: false },
                  content,
                })
              ).publishedSha256;
        } catch (error) {
          if (error instanceof GovernedFileHandlePortRefusalError) throw destinationChanged();
          throw Object.assign(
            new ConflictError({
              message: "Publishing could not be verified. Check the original project file before trying again.",
            }),
            { mutationCommitted: true },
          );
        }
        return { status: "published", path: file.path, contentSha256 };
      } finally {
        current.content?.fill(0);
      }
    },
  };
}

function destinationChanged() {
  return new ConflictError({
    message: "The destination or overwrite confirmation changed. Review it again before publishing.",
  });
}
