/** Schema files, in order. The same files the Cloudflare target applies to D1. */
import init from '../../migrations/0001_init.sql';
import searchV2 from '../../migrations/0002_search_v2.sql';
import deletions from '../../migrations/0003_deletions.sql';
import connections from '../../migrations/0004_connections.sql';
import hubState from '../../migrations/0005_hub_state.sql';

export const MIGRATIONS: string[] = [init, searchV2, deletions, connections, hubState];
