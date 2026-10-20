# Releasing SubMotion

Windows, with After Effects installed. Everything runs from the `submotion` folder.

1. **Bump the version** in `package.json` (the manifest version is set from it when packaging).
2. **Templates** (only if the template code or the default preset changed): open a *saved* After
   Effects project and run `npm run build:template`. Commit the two files in `assets/mogrt/`.
3. **Check**: `npm test`, `npm run typecheck`, `npm run check:jsx`, and with After Effects open
   `npm run verify:ae`.
4. **Package**: `npm run package`. This builds the panel, downloads the pinned, checksum-verified
   whisper.cpp build into `bin/win`, and writes the signed `release/SubMotion-<version>.zxp`.
   FFmpeg and the models are not in the package: the panel downloads them on first use.
   - First run only: creates a self-signed certificate in `signing/`. **Back up `signing/`** (it is
     git-ignored); sign every future release with the same certificate.
   - No signing timestamp: ZXPSignCmd 4.1.103 crashes with timestamp servers, so the signature is
     valid for the certificate's 10-year lifetime.
5. **Publish**: create a GitHub release tagged `v<version>` and attach the `.zxp`. In the notes, link
   `THIRD_PARTY_NOTICES.md`.
6. **Smoke test** the `.zxp` on a machine *without* the development link (a dev junction in
   `%APPDATA%\Adobe\CEP\extensions\com.submotion` would shadow the installed copy).
