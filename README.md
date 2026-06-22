This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

Import the GitHub repo in the [Vercel dashboard](https://vercel.com/new). The project includes a `vercel.json` that:

- Runs `scripts/vercel-install.sh`, which on Vercel builds **LibRaw from the copy bundled inside `lightdrift-libraw`** (Amazon Linux 2023 has no `LibRaw-devel` package), then rebuilds the native addon.
- Sets **`NODE_OPTIONS=--max-old-space-size=8192`** for the build step.

**Node.js:** use **20.x** (pinned via `.nvmrc` and `package.json` `engines`). Vercel’s default Node 24 is unsupported for `lightdrift-libraw` native builds.

**Environment variables** (Project → Settings → Environment Variables):

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY` (for `/api/train/*` routes)

If the dashboard has a custom Install Command or Node version set, remove or align them with `vercel.json` / `.nvmrc` so they do not override the repo config.

**Note:** Server-side RAW decode (`/api/decode/raw`, `/api/decode/rd1`, training routes) requires the compiled native module at runtime. If those routes fail after a successful build, consider hosting RAW decode on a Docker-based service instead of Vercel serverless.
