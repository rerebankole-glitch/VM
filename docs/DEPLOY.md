# Deploying to GitHub Pages

The site is plain static files: `index.html`, `app/`, `assets/`, `docs/` and `.nojekyll`.
There is nothing to compile, so hosting it is mostly a matter of telling GitHub to publish
those files.

The site works with either Pages source. **“Deploy from a branch”** is the simplest
(GitHub publishes the repository itself; the workflow then just runs the tests), while
**“GitHub Actions”** lets the workflow publish only the files the site needs, with the test
suite acting as a gate. Neither needs a build step.

## Option A — GitHub Actions

1. Push the repository to GitHub.
2. Open **Settings → Pages**. Only the repository owner can do this step; the workflow's
   token is not allowed to create the Pages site, so it prints the same instruction in the
   Actions log (and the `Deploy` job stops with a link to this settings page) until it is
   done.
3. Under **Build and deployment → Source**, choose **GitHub Actions**.
4. Push to `main` (or run the workflow manually from the **Actions** tab →
   *Test and deploy to GitHub Pages* → **Run workflow**).
5. The run finishes with a green tick, and the deployment URL appears in the job summary
   and in **Settings → Pages**: `https://<user>.github.io/<repo>/`.

In this mode the workflow also checks how Pages is configured on every run and tells you which
mode is active, so nothing fails silently.

What the workflow does:

| Job | Steps |
| --- | --- |
| `test` | `npm test` — catalogue checks, asset checks, interface wiring checks and real boots of the bundled images in v86's Node mode |
| `build` | copies `index.html`, `app/`, `assets/`, `docs/` and `.nojekyll` into `_site` and uploads it as the Pages artifact |
| `deploy` | publishes the artifact with `actions/deploy-pages` |

The workflow only needs the default token; the permissions it requests (`pages: write`,
`id-token: write`) are the standard Pages ones.

### Repository settings the workflow relies on

* **Settings → Environments → `github-pages`** is created automatically the first time.
  If you add protection rules, keep the `main` branch allowed to deploy.
* Keep `main` as the default branch, or update the `branches:` filter in
  `.github/workflows/pages.yml` to the branch you use.

## Option B — deploy straight from a branch

GitHub can also publish the repository contents directly, without Actions:

1. **Settings → Pages → Source: Deploy from a branch.**
2. Branch: `main`, folder: `/ (root)`. Save.
3. GitHub serves the repository root, with `index.html` as the entry point.

This works because every path in the site is relative. It skips the test run, so run
`npm test` yourself before pushing if you change the application.

## Private repositories

GitHub Pages serves pages from private repositories only on paid plans (Pro/Team/Enterprise).
On a free account the Pages section stays limited to public repositories. The site itself
contains no secrets, so making the repository public is the usual answer — or host the same
files on Cloudflare Pages, Netlify, Vercel or any web server.

## Custom domains, sub-paths and HTTPS

* Project sites are served from a sub-path (`/<repo>/`). The application uses only relative
  URLs, so it works unchanged in that situation.
* For a custom domain add a `CNAME` file containing the domain, and point a DNS `CNAME`
  (or `A`/`AAAA` for apex domains) at GitHub Pages. See GitHub's
  [custom domain documentation](https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site).
* Enforce HTTPS in **Settings → Pages** once the certificate is issued.
* A user/organisation site (`<user>.github.io`) expects the files at the repository root,
  which is exactly the layout used here.

## Verifying a deployment

```bash
curl -sI https://<user>.github.io/<repo>/                 # expect 200 + text/html
curl -sI https://<user>.github.io/<repo>/assets/v86/v86.wasm   # expect 200 + application/wasm
```

In the browser, open the site, keep the network tab open and press **Boot** with the
built-in *Tiny Linux* image selected. You should see:

1. `libv86.js`, then `v86.wasm` (about 2 MB) load.
2. `seabios.bin` and `vgabios.bin` load.
3. `assets/images/tiny-linux.iso` load (5.4 MB), after which the BIOS text appears and the
   guest boots to a shell.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| 404 on the Pages URL | Pages is not enabled yet, or the first deployment is still running. Check the **Actions** tab; if the `Deploy` job says *Failed to create deployment … Ensure GitHub Pages has been enabled*, flip **Settings → Pages → Source: GitHub Actions** and re-run the run. |
| Page loads but the screen stays black | `application/wasm` is not being served. On GitHub Pages it is automatic; on your own host add the MIME type. The emulator falls back to `v86-fallback.wasm`, so check that file is deployed too. |
| `v86.d.ts does not declare …` or other test failures | Run `npm test` locally; the workflow refuses to publish a broken site. |
| Images missing (`assets/images/*`) | The vendored demo images are large. If you used `git clone --depth 1 --filter=blob:none` or `.gitattributes` LFS rules, fetch them again or run `npm run vendor:images`. |
| Everything works locally, not on Pages | Check the repository's `.nojekyll` file exists — without it, Jekyll processing can delay or skip files. |
| Old version still served | Hard-reload (Ctrl/Cmd+Shift+R). Pages caches aggressively at the CDN edge. |

## Hosting something else instead

Any static host works, as long as it serves `.wasm` as `application/wasm` and does not strip
`Range` headers (used when a disk image is booted from a URL):

* **Cloudflare Pages / Netlify / Vercel** — connect the repository, leave the build command
  empty, set the output directory to `/`.
* **nginx** — `types { application/wasm wasm; }` and `git clone` the repository into the web
  root. Add `add_header Access-Control-Allow-Origin "*"` if you want other sites to boot ISOs
  from your server.
* **Local network** — `npm start` binds `0.0.0.0` on port 8080, so phones and other machines
  on the same network can use it.
