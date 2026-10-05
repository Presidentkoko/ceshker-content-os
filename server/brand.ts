import { config } from './config.js';
import { BRANDS, type Brand } from '../shared/brand.js';

/** The brand this deployment serves (BRAND env, default "ceshker"). */
export const brand: Brand = BRANDS[config.BRAND];

/** Drive folder with this brand's videos. DRIVE_FOLDER_ID, or the older NFAMATION_DRIVE_FOLDER_ID. */
export function driveFolderId(): string | undefined {
  return config.DRIVE_FOLDER_ID ?? config.NFAMATION_DRIVE_FOLDER_ID;
}
