# Upgrade and removal

Use an exact released GitHub tag when upgrading. Check the release notes and the
[generated compatibility reference](reference/generated.md) first. Preserve your
OMP profile using your normal private backup procedure before a migration.

```text
omp plugin install https://github.com/CruxExperts/OMP-OmniRoute-Provider#v1.0.1
```

Restart OMP, run `/omniroute`, and refresh discovery. The GitHub release does not imply npm publication. The package identity and
`omniroute` provider identity remain stable. A client update does not update your
OmniRoute server. Existing environment variable names and native runtime
credential storage remain the configuration owners.

The plugin display name is **OMP OmniRoute Provider**; OMP's `/login` provider
selector labels the entry **Crux OmniRoute Provider**. The provider ID remains
`omniroute`, and this label change does not reset stored credentials or OMP
profile configuration.

The primary commands are now `/omniroute`, `/omniroute-admin`, and
`/omniroute-pricing`. The earlier `/cruxomni`, `/cruxomni-admin`, and
`/cruxomni-pricing` forms remain available as aliases; no command migration is
required.

If reverting to `1.0.0`, reconcile the environment connection before starting
that version. `1.0.0` does not recognize the native-source preference added in
`1.0.1`, so existing runtime environment variables can select their endpoint
and key again. Confirm that the older version's environment-selected connection
is the intended target; do not assume the `1.0.1` native selection carries back.

If an upgrade fails, install the previously qualified exact package version and
restart OMP. Check release notes for configuration migrations before reverting a
profile. Do not overwrite a working profile with another machine's credentials.

To remove the package, disable administration first and use OMP's native package
management interface. Consult `omp --help` for your installed host's removal
command. Restart OMP and confirm the extension is absent. Uninstalling the client
does not revoke server keys: revoke unused credentials through OmniRoute and
remove any environment variables you supplied separately. Keep shared OMP
credentials until you confirm other extensions do not use them.
