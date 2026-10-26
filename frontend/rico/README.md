# Rico (locked)

Rico, Reroute's companion, is the owner's own character, and his code is the owner's too. He is in this repository only as `rico.pack`, encrypted (AES-256-GCM): his Blender model and the scripts that build and render it, the sheets of his rendered pieces that the app moves in 3D, his stills, his picture in the Android app, his code (his screens and chat, his 3D, his voice, his agent on the server, "Hey Rico" on Android) and the notes on how he's built (`files.txt` lists them all). Without the key the pack can't be opened: the website and the API build and run without Rico (`src/lib/rico.tsx` stands in for him), and the Android app needs the key.

Rico's look, model, renders, pictures, voice and code are not licensed for use outside Reroute. All rights reserved.

## For the owner

The key is `RICO_KEY` (64 hex characters) in the `.env` at the repository's root. Keep a copy somewhere safe, such as a password manager: if the key is lost, the pack can't be opened again.

- **Builds open the pack by themselves** (`pnpm build`, `pnpm build:android`, `pnpm dev`), writing Rico's files where the app, the API and Blender expect them. Git ignores those files. A fresh clone needs `pnpm rico:unlock` (in `frontend/`) before the API's tests or a Docker build.
- **After changing any of his files** (his code, `render_roo.py`, `roo3d/stills.mjs`), lock them again and commit the new pack: `pnpm rico:lock`. A new file of his goes in `files.txt` and the root `.gitignore` first.
- **The Azure deploy** opens the pack on the server before building (`infra/azure/deploy.sh`), with the `RICO_KEY` in its settings.
- **GitHub Actions** opens the pack with a repository secret named `RICO_KEY` holding the same key (Settings → Secrets and variables → Actions). Without it, CI builds without Rico and his checks don't run.
- `node rico/lock.mjs status` says whether the key is found and the files match the pack.
