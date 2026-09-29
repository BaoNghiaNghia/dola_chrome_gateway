# Dola Chrome Gateway project workflow

For every task that changes application code, runtime code, assets, configuration, or build scripts:

1. Run `npm run build:portable` after the implementation is complete.
2. Do not report the task complete if the portable build fails.
3. If the task includes pushing to `main`, run `npm run build:win` before the push so the Windows installer is rebuilt and verified.
4. Keep generated release artifacts under `release/windows`; they are intentionally gitignored.
5. Do not bypass automatic build hooks except for an explicit user request or an emergency diagnostic.

The repository also uses Git hooks from `.githooks`:
- `pre-commit`: portable rebuild + verification.
- `pre-push`: full Windows/NSIS rebuild.
- `post-merge`: portable rebuild after pull/merge.
