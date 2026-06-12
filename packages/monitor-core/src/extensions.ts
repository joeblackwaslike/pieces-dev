import { dataIntegrity } from '@pieces-dev/data-integrity';
import type { Extension } from '@pieces-dev/monitor-sdk';
import { watchdog } from '@pieces-dev/watchdog';

/**
 * The extensions the daemon loads at boot, in order. Each is loaded through the
 * {@link Host} (which builds its namespaced context) before the HTTP server is
 * built, so any routes they register are mounted exactly once.
 */
export const extensions: Extension[] = [watchdog, dataIntegrity];
