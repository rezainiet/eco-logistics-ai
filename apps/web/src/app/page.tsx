/**
 * Stub — the real landing lives in `app/(marketing)/page.tsx`.
 *
 * This file exists only because the previous `page.tsx` could not be deleted
 * from the assistant's environment. Both files register `/`; Next.js dev
 * tolerates the conflict and the production build will reject it. Delete
 * this file to clean up:
 *
 *   Remove-Item apps/web/src/app/page.tsx     (PowerShell)
 *   rm apps/web/src/app/page.tsx              (bash / git-bash / WSL)
 *
 * The re-export means visitors see the new (marketing) landing whether or
 * not you've deleted the file yet.
 */
export { default, metadata } from "./(marketing)/page";
