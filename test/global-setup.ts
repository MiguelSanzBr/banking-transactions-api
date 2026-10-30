import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { createPool, migrate } from '../src/db.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const databaseUrl = container.getConnectionUri();
  const pool = createPool(databaseUrl);
  await migrate(pool);
  await pool.end();
  project.provide('databaseUrl', databaseUrl);
  return () => container.stop();
}
