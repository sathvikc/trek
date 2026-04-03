import { db, canAccessTrip } from '../db/database';
import { notifyTripMembers } from './notifications';

type ServiceError = { error: string; status: number };

function accessDeniedIfMissing(tripId: string, userId: number): ServiceError | null {
  if (!canAccessTrip(tripId, userId)) {
    return { error: 'Trip not found', status: 404 };
  }
  return null;
}

type Selection = {
  provider: string;
  asset_ids: unknown[];
};

function normalizeSelections(selectionsRaw: unknown, providerRaw: unknown, assetIdsRaw: unknown): Selection[] {
  const selectionsFromBody = Array.isArray(selectionsRaw) ? selectionsRaw : null;
  const provider = String(providerRaw || '').toLowerCase();

  if (selectionsFromBody && selectionsFromBody.length > 0) {
    return selectionsFromBody
      .map((selection: any) => ({
        provider: String(selection?.provider || '').toLowerCase(),
        asset_ids: Array.isArray(selection?.asset_ids) ? selection.asset_ids : [],
      }))
      .filter((selection: Selection) => selection.provider && selection.asset_ids.length > 0);
  }

  if (provider && Array.isArray(assetIdsRaw) && assetIdsRaw.length > 0) {
    return [{ provider, asset_ids: assetIdsRaw }];
  }

  return [];
}

export function listTripPhotos(tripId: string, userId: number): { photos: any[] } | ServiceError {
  const denied = accessDeniedIfMissing(tripId, userId);
  if (denied) return denied;

  const photos = db.prepare(`
    SELECT tp.asset_id, tp.provider, tp.user_id, tp.shared, tp.added_at,
           u.username, u.avatar
    FROM trip_photos tp
    JOIN users u ON tp.user_id = u.id
    WHERE tp.trip_id = ?
      AND (tp.user_id = ? OR tp.shared = 1)
    ORDER BY tp.added_at ASC
  `).all(tripId, userId) as any[];

  return { photos };
}

export function listTripAlbumLinks(tripId: string, userId: number): { links: any[] } | ServiceError {
  const denied = accessDeniedIfMissing(tripId, userId);
  if (denied) return denied;

  const links = db.prepare(`
    SELECT tal.id,
           tal.trip_id,
           tal.user_id,
           tal.provider,
           tal.album_id,
           tal.album_name,
           tal.sync_enabled,
           tal.last_synced_at,
           tal.created_at,
           u.username
    FROM trip_album_links tal
    JOIN users u ON tal.user_id = u.id
    WHERE tal.trip_id = ?
    ORDER BY tal.created_at ASC
  `).all(tripId);

  return { links };
}

export function createTripAlbumLink(
  tripId: string,
  userId: number,
  providerRaw: unknown,
  albumIdRaw: unknown,
  albumNameRaw: unknown,
): { success: true } | ServiceError {
  const denied = accessDeniedIfMissing(tripId, userId);
  if (denied) return denied;

  const provider = String(providerRaw || '').toLowerCase();
  const albumId = String(albumIdRaw || '').trim();
  const albumName = String(albumNameRaw || '').trim();

  if (!provider) {
    return { error: 'provider is required', status: 400 };
  }
  if (!albumId) {
    return { error: 'album_id required', status: 400 };
  }

  try {
    db.prepare(
      'INSERT OR IGNORE INTO trip_album_links (trip_id, user_id, provider, album_id, album_name) VALUES (?, ?, ?, ?, ?)'
    ).run(tripId, userId, provider, albumId, albumName);
    return { success: true };
  } catch {
    return { error: 'Album already linked', status: 400 };
  }
}

export function removeAlbumLink(tripId: string, linkId: string, userId: number): { success: true } | ServiceError {
  const denied = accessDeniedIfMissing(tripId, userId);
  if (denied) return denied;

  db.prepare('DELETE FROM trip_album_links WHERE id = ? AND trip_id = ? AND user_id = ?')
    .run(linkId, tripId, userId);

  return { success: true };
}

export function addTripPhotos(
  tripId: string,
  userId: number,
  sharedRaw: unknown,
  selectionsRaw: unknown,
  providerRaw: unknown,
  assetIdsRaw: unknown,
): { success: true; added: number; shared: boolean } | ServiceError {
  const denied = accessDeniedIfMissing(tripId, userId);
  if (denied) return denied;

  const shared = sharedRaw === undefined ? true : !!sharedRaw;
  const selections = normalizeSelections(selectionsRaw, providerRaw, assetIdsRaw);
  if (selections.length === 0) {
    return { error: 'selections required', status: 400 };
  }

  const insert = db.prepare(
    'INSERT OR IGNORE INTO trip_photos (trip_id, user_id, asset_id, provider, shared) VALUES (?, ?, ?, ?, ?)'
  );

  let added = 0;
  for (const selection of selections) {
    for (const raw of selection.asset_ids) {
      const assetId = String(raw || '').trim();
      if (!assetId) continue;
      const result = insert.run(tripId, userId, assetId, selection.provider, shared ? 1 : 0);
      if (result.changes > 0) added++;
    }
  }

  return { success: true, added, shared };
}

export function removeTripPhoto(
  tripId: string,
  userId: number,
  providerRaw: unknown,
  assetIdRaw: unknown,
): { success: true } | ServiceError {
  const assetId = String(assetIdRaw || '');
  const provider = String(providerRaw || '').toLowerCase();

  if (!assetId) {
    return { error: 'asset_id is required', status: 400 };
  }
  if (!provider) {
    return { error: 'provider is required', status: 400 };
  }

  const denied = accessDeniedIfMissing(tripId, userId);
  if (denied) return denied;

  db.prepare(`
    DELETE FROM trip_photos
    WHERE trip_id = ?
      AND user_id = ?
      AND asset_id = ?
      AND provider = ?
  `).run(tripId, userId, assetId, provider);

  return { success: true };
}

export function setTripPhotoSharing(
  tripId: string,
  userId: number,
  providerRaw: unknown,
  assetIdRaw: unknown,
  sharedRaw: unknown,
): { success: true } | ServiceError {
  const assetId = String(assetIdRaw || '');
  const provider = String(providerRaw || '').toLowerCase();

  if (!assetId) {
    return { error: 'asset_id is required', status: 400 };
  }
  if (!provider) {
    return { error: 'provider is required', status: 400 };
  }

  const denied = accessDeniedIfMissing(tripId, userId);
  if (denied) return denied;

  db.prepare(`
    UPDATE trip_photos
    SET shared = ?
    WHERE trip_id = ?
      AND user_id = ?
      AND asset_id = ?
      AND provider = ?
  `).run(sharedRaw ? 1 : 0, tripId, userId, assetId, provider);

  return { success: true };
}

export async function notifySharedTripPhotos(
  tripId: string,
  actorUserId: number,
  actorName: string,
  added: number,
): Promise<void> {
  if (added <= 0) return;

  const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
  await notifyTripMembers(Number(tripId), actorUserId, 'photos_shared', {
    trip: tripInfo?.title || 'Untitled',
    actor: actorName,
    count: String(added),
  });
}
