# Upgrade and removal

Use a qualified exact version when upgrading. Check the release notes and the
[generated compatibility reference](reference/generated.md) first. Preserve your
OMP profile using your normal private backup procedure before a migration.

```text
omp install @cruxexperts/cruxomni-omp-client@<qualified-version>
```

Restart OMP, run `/cruxomni`, and refresh discovery. The package identity and
`omniroute` provider identity remain stable. A client update does not update your
OmniRoute server. Existing environment variable names and native runtime
credential storage remain the configuration owners.

The current public display name is **OMP OmniRoute Provider**. The existing
`/cruxomni` commands and package identity remain in use for compatibility; this
branding change does not reset stored credentials or OMP profile configuration.

If an upgrade fails, install the previously qualified exact package version and
restart OMP. Check release notes for configuration migrations before reverting a
profile. Do not overwrite a working profile with another machine's credentials.

To remove the package, disable administration first and use OMP's native package
management interface. Consult `omp --help` for your installed host's removal
command. Restart OMP and confirm the extension is absent. Uninstalling the client
does not revoke server keys: revoke unused credentials through OmniRoute and
remove any environment variables you supplied separately. Keep shared OMP
credentials until you confirm other extensions do not use them.
