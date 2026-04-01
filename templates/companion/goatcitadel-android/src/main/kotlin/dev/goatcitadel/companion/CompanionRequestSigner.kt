package dev.goatcitadel.companion

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.util.Base64

object CompanionRequestSigner {
    fun buildHeaders(
        privateKey: PrivateKey,
        method: String,
        path: String,
        timestamp: String,
        nonce: String,
        bodyJson: String?,
    ): Map<String, String> {
        val payload = buildPayload(
            method = method,
            path = path,
            timestamp = timestamp,
            nonce = nonce,
            bodyJson = bodyJson,
        )
        val signature = Signature.getInstance("Ed25519").run {
            initSign(privateKey)
            update(payload.toByteArray(StandardCharsets.UTF_8))
            sign()
        }

        return mapOf(
            "x-goatcitadel-companion-timestamp" to timestamp,
            "x-goatcitadel-companion-nonce" to nonce,
            "x-goatcitadel-companion-signature" to Base64.getUrlEncoder().withoutPadding().encodeToString(signature),
        )
    }

    fun buildPayload(
        method: String,
        path: String,
        timestamp: String,
        nonce: String,
        bodyJson: String?,
    ): String {
        val canonicalBody = bodyJson?.trim().orEmpty()
        val bodyHash = sha256Hex(canonicalBody)
        return buildString {
            append(method.trim().uppercase())
            append('\n')
            append(path.trim())
            append('\n')
            append(timestamp.trim())
            append('\n')
            append(nonce.trim())
            append('\n')
            append(bodyHash)
        }
    }

    private fun sha256Hex(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
        return digest.joinToString(separator = "") { byte -> "%02x".format(byte) }
    }
}
