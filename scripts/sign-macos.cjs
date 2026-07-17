'use strict'

const { signAsync } = require('@electron/osx-sign')

/**
 * electron-builder skips macOS signing when CI has no Developer ID certificate.
 * Electron still needs a coherent signature for hardened-runtime framework loading,
 * so use one ad-hoc identity as the safe fallback and preserve the configured
 * per-file entitlements/signing order from electron-builder.
 */
async function sign(configuration) {
  const identity = configuration.identity || '-'

  await signAsync({
    ...configuration,
    identity,
    identityValidation: false,
    timestamp: identity === '-' ? false : configuration.timestamp
  })
}

module.exports = { sign }
