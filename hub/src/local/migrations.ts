/** Schema files, in order. The same files the Cloudflare target applies to D1. */
import init from '../../migrations/0001_init.sql';
import searchV2 from '../../migrations/0002_search_v2.sql';

export const MIGRATIONS: string[] = [init, searchV2];
