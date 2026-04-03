import express, { Request, Response } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest } from '../types';

const router = express.Router();


router.get('/trips/:tripId/photos', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;

    if (!canAccessTrip(tripId, authReq.user.id)) {
        return res.status(404).json({ error: 'Trip not found' });
    }

    const photos = db.prepare(`
    SELECT tp.asset_id, tp.provider, tp.user_id, tp.shared, tp.added_at,
           u.username, u.avatar
    FROM trip_photos tp
    JOIN users u ON tp.user_id = u.id
    WHERE tp.trip_id = ?
      AND (tp.user_id = ? OR tp.shared = 1)
    ORDER BY tp.added_at ASC
  `).all(tripId, authReq.user.id) as any[];

    res.json({ photos });
});

router.get('/trips/:tripId/album-links', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;

    if (!canAccessTrip(tripId, authReq.user.id)) {
        return res.status(404).json({ error: 'Trip not found' });
    }

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

    res.json({ links });
});

router.delete('/trips/:tripId/album-links/:linkId', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId, linkId } = req.params;

    if (!canAccessTrip(tripId, authReq.user.id)) {
        return res.status(404).json({ error: 'Trip not found' });
    }

    db.prepare('DELETE FROM trip_album_links WHERE id = ? AND trip_id = ? AND user_id = ?')
        .run(linkId, tripId, authReq.user.id);

    res.json({ success: true });
    broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
});

router.post('/trips/:tripId/photos', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const { shared = true } = req.body;
    const selectionsRaw = Array.isArray(req.body?.selections) ? req.body.selections : null;
    const provider = String(req.body?.provider || '').toLowerCase();
    const assetIdsRaw = req.body?.asset_ids;

    if (!canAccessTrip(tripId, authReq.user.id)) {
        return res.status(404).json({ error: 'Trip not found' });
    }

    const selections = selectionsRaw && selectionsRaw.length > 0
        ? selectionsRaw
            .map((selection: any) => ({
                provider: String(selection?.provider || '').toLowerCase(),
                asset_ids: Array.isArray(selection?.asset_ids) ? selection.asset_ids : [],
            }))
            .filter((selection: { provider: string; asset_ids: unknown[] }) => selection.provider && selection.asset_ids.length > 0)
        : (provider && Array.isArray(assetIdsRaw) && assetIdsRaw.length > 0
            ? [{ provider, asset_ids: assetIdsRaw }]
            : []);

    if (selections.length === 0) {
        return res.status(400).json({ error: 'selections required' });
    }

    const insert = db.prepare(
        'INSERT OR IGNORE INTO trip_photos (trip_id, user_id, asset_id, provider, shared) VALUES (?, ?, ?, ?, ?)'
    );

    let added = 0;
    for (const selection of selections) {
        for (const raw of selection.asset_ids) {
            const assetId = String(raw || '').trim();
            if (!assetId) continue;
            const result = insert.run(tripId, authReq.user.id, assetId, selection.provider, shared ? 1 : 0);
            if (result.changes > 0) added++;
        }
    }

    res.json({ success: true, added });
    broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);

    if (shared && added > 0) {
        import('../services/notifications').then(({ notifyTripMembers }) => {
            const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
            notifyTripMembers(Number(tripId), authReq.user.id, 'photos_shared', {
                trip: tripInfo?.title || 'Untitled',
                actor: authReq.user.username || authReq.user.email,
                count: String(added),
            }).catch(() => {});
        });
    }
});

router.delete('/trips/:tripId/photos', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const provider = String(req.body?.provider || '').toLowerCase();
    const assetId = String(req.body?.asset_id || '');

    if (!assetId) {
        return res.status(400).json({ error: 'asset_id is required' });
    }

    if (!provider) {
        return res.status(400).json({ error: 'provider is required' });
    }

    if (!canAccessTrip(tripId, authReq.user.id)) {
        return res.status(404).json({ error: 'Trip not found' });
    }

    db.prepare(`
        DELETE FROM trip_photos
        WHERE trip_id = ?
            AND user_id = ?
            AND asset_id = ?
            AND provider = ?
    `).run(tripId, authReq.user.id, assetId, provider);

    res.json({ success: true });
    broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
});

router.put('/trips/:tripId/photos/sharing', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const provider = String(req.body?.provider || '').toLowerCase();
    const assetId = String(req.body?.asset_id || '');
    const { shared } = req.body;

    if (!assetId) {
        return res.status(400).json({ error: 'asset_id is required' });
    }

    if (!provider) {
        return res.status(400).json({ error: 'provider is required' });
    }

    if (!canAccessTrip(tripId, authReq.user.id)) {
        return res.status(404).json({ error: 'Trip not found' });
    }

    db.prepare(`
        UPDATE trip_photos
        SET shared = ?
        WHERE trip_id = ?
            AND user_id = ?
            AND asset_id = ?
            AND provider = ?
    `).run(shared ? 1 : 0, tripId, authReq.user.id, assetId, provider);

    res.json({ success: true });
    broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
});

export default router;
