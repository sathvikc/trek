import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest } from '../types';
import {
    listTripPhotos,
    listTripAlbumLinks,
    createTripAlbumLink,
    removeAlbumLink,
    addTripPhotos,
    removeTripPhoto,
    setTripPhotoSharing,
    notifySharedTripPhotos,
} from '../services/memoriesService';

const router = express.Router();


router.get('/trips/:tripId/photos', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
        const result = listTripPhotos(tripId, authReq.user.id);
        if ('error' in result) return res.status(result.status).json({ error: result.error });
        res.json({ photos: result.photos });
});

router.get('/trips/:tripId/album-links', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const result = listTripAlbumLinks(tripId, authReq.user.id);
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.json({ links: result.links });
});

router.delete('/trips/:tripId/album-links/:linkId', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId, linkId } = req.params;
    const result = removeAlbumLink(tripId, linkId, authReq.user.id);
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.json({ success: true });
    broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
});

router.post('/trips/:tripId/photos', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const result = addTripPhotos(
        tripId,
        authReq.user.id,
        req.body?.shared,
        req.body?.selections,
        req.body?.provider,
        req.body?.asset_ids,
    );
    if ('error' in result) return res.status(result.status).json({ error: result.error });

    res.json({ success: true, added: result.added });
    broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);

    if (result.shared && result.added > 0) {
        void notifySharedTripPhotos(
            tripId,
            authReq.user.id,
            authReq.user.username || authReq.user.email,
            result.added,
        ).catch(() => {});
    }
});

router.delete('/trips/:tripId/photos', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const result = removeTripPhoto(tripId, authReq.user.id, req.body?.provider, req.body?.asset_id);
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.json({ success: true });
    broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
});

router.put('/trips/:tripId/photos/sharing', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const result = setTripPhotoSharing(
        tripId,
        authReq.user.id,
        req.body?.provider,
        req.body?.asset_id,
        req.body?.shared,
    );
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.json({ success: true });
    broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
});

router.post('/trips/:tripId/album-links', authenticate, (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId } = req.params;
    const result = createTripAlbumLink(tripId, authReq.user.id, req.body?.provider, req.body?.album_id, req.body?.album_name);
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    res.json({ success: true });
});

export default router;
