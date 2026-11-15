// Validate the actual source response before retaining only its public projection.
export function projectMfaStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'backupCodesRemaining,enabled,enabledAt,recoverySwitchSet'
      || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.backupCodesRemaining) || value.backupCodesRemaining < 0
      || (value.enabledAt !== null && typeof value.enabledAt !== 'string') || typeof value.recoverySwitchSet !== 'boolean') {
    throw new Error('INGRESS_INVALID_MFA_STATUS_RESPONSE');
  }
  return { enabled: value.enabled, backupCodesRemaining: value.backupCodesRemaining, recoverySwitchSet: value.recoverySwitchSet };
}
