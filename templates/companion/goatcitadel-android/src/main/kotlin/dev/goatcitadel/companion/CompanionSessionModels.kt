package dev.goatcitadel.companion

data class CompanionSessionExchangeRequest(
    val signingPublicKeyPem: String,
    val clientName: String? = null,
    val appVersion: String? = null,
)

data class CompanionSessionRefreshRequest(
    val refreshToken: String,
)

data class CompanionSessionBundle(
    val contractId: String,
    val sessionId: String,
    val grantId: String,
    val actorId: String,
    val accessToken: String,
    val accessTokenExpiresAt: String,
    val refreshToken: String,
    val refreshTokenExpiresAt: String,
    val issuedAt: String,
    val signatureAlgorithm: String,
)

data class CompanionSessionInfo(
    val contractId: String,
    val sessionId: String,
    val grantId: String,
    val actorId: String,
    val deviceLabel: String,
    val deviceType: String,
    val platform: String? = null,
    val createdAt: String,
    val lastSeenAt: String? = null,
    val accessTokenExpiresAt: String,
    val refreshTokenExpiresAt: String,
    val signatureAlgorithm: String,
    val metadata: Map<String, Any?> = emptyMap(),
)
