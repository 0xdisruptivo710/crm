import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @aios-pocket/contracts é workspace package (pnpm) com fonte TypeScript crua (sem
  // build — main aponta para src/index.ts) e specifiers de import com sufixo `.js`
  // apontando para arquivos `.ts` irmãos (convenção TS "moduleResolution: bundler").
  // Sem isto o Turbopack trata o pacote como node_modules já compilado e não aplica o
  // fallback `.js` -> `.ts`, quebrando `export * from './webhooks.js'` em
  // packages/contracts/src/index.ts (Task 7, Plano C).
  transpilePackages: ["@aios-pocket/contracts"],
};

export default nextConfig;
