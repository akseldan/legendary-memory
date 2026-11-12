/** Schema files, in order. The same files the Cloudflare target applies to D1. */
import init from '../../migrations/0001_init.sql';

export const MIGRATIONS: string[] = [init];
