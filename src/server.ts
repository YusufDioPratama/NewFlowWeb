import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { PrismaClient, Role, OrderStatus, WorkSegmentation, PriorityLevel } from '@prisma/client';
import { DummySmartsheetAdapter } from './adapters/smartsheet.js';
import { SyncService } from './services/sync.js';
import { WorkflowService, TRANSITIONS, PROTECTED_TARGETS, ADMIN_ROLES } from './services/workflow.js';
import { DockingService } from './services/docking.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ponytail: Vercel serverless has a read-only filesystem except /tmp
function getDatabaseUrl(): string {
  if (process.env.VERCEL) {
    const tmpDbPath = '/tmp/dev.db';
    if (!fs.existsSync(tmpDbPath)) {
      const candidates = [
        path.join(process.cwd(), 'prisma', 'dev.db'),
        path.join(__dirname, '../prisma', 'dev.db'),
        path.join(__dirname, 'prisma', 'dev.db'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          try {
            fs.copyFileSync(p, tmpDbPath);
            console.log(`[Vercel Serverless] Seeded DB copied to ${tmpDbPath}`);
            break;
          } catch (e) {
            console.error('[Vercel Serverless] Failed to copy seed DB:', e);
          }
        }
      }
    }
    return 'file:/tmp/dev.db';
  }
  return process.env.DATABASE_URL || 'file:./dev.db';
}

const dbUrl = getDatabaseUrl();
process.env.DATABASE_URL = dbUrl;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: dbUrl
    }
  }
});
const adapter = new DummySmartsheetAdapter();
const syncService = new SyncService(prisma, adapter);
const workflowService = new WorkflowService(prisma);
const dockingService = new DockingService(prisma, workflowService);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Auto-seed on cold start if database is fresh
let isDbReady = false;
async function ensureDatabaseReady() {
  if (isDbReady) return;
  try {
    const count = await prisma.fleet.count().catch(() => 0);
    if (count === 0) {
      await syncService.syncFleetMaster();
      await syncService.syncNoonReport();
      await syncService.syncPms();
    }
    isDbReady = true;
  } catch (err) {
    console.error('[DB Readiness Check Failed]:', err);
  }
}

app.use(async (_req, _res, next) => {
  await ensureDatabaseReady();
  next();
});

// ponytail: Role dari header untuk mode dev, ganti ke JWT/SSO kredensial resmi saat produksi
const getActorContext = (req: Request) => {
  const actorRole = (req.headers['x-actor-role'] as Role) || Role.OMA_ADMIN;
  const actorId = (req.headers['x-actor-id'] as string) || 'system-admin';
  return { actorRole, actorId };
};

// GET /api/workflow-rules -> matriks transisi & role berhak (untuk UI Panduan Alur)
app.get('/api/workflow-rules', (_req: Request, res: Response) => {
  res.json({
    transitions: TRANSITIONS,
    protectedTargets: PROTECTED_TARGETS,
    adminRoles: ADMIN_ROLES
  });
});

// GET /api/users
app.get('/api/users', async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fleets
app.get('/api/fleets', async (_req: Request, res: Response) => {
  try {
    const fleets = await prisma.fleet.findMany({
      include: {
        noonReports: { orderBy: { reportDate: 'desc' }, take: 1 },
        equipments: true
      }
    });
    res.json(fleets);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders
app.get('/api/orders', async (_req: Request, res: Response) => {
  try {
    const orders = await prisma.workOrder.findMany({
      include: {
        fleet: true,
        defect: true,
        bast: true,
        costEstimate: true,
        workshop: true,
        dockingOrder: {
          include: { addendums: true, milestones: true }
        },
        tracking: { orderBy: { timestamp: 'desc' } }
      },
      orderBy: { updatedAt: 'desc' }
    });
    res.json(orders);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders (Input temuan -> Defect List -> Work Order, oleh Kapal / Jr TS / OMA)
app.post('/api/orders', async (req: Request, res: Response) => {
  try {
    const { actorRole, actorId } = getActorContext(req);
    const { fleetId, deskripsi, sumber, priority, segmentasi, pekerjaan, targetDays, rkaPagu } = req.body;

    const creatorRoles: Role[] = [Role.KAPAL, Role.JR_TS, ...ADMIN_ROLES];
    if (!creatorRoles.includes(actorRole)) {
      return res.status(403).json({ error: `Role ${actorRole} dilarang membuat Work Order` });
    }
    if (!fleetId || !deskripsi || !pekerjaan) {
      return res.status(400).json({ error: 'Field fleetId, deskripsi, dan pekerjaan wajib diisi' });
    }

    const fleet = await prisma.fleet.findUnique({ where: { id: fleetId } });
    if (!fleet) {
      return res.status(400).json({ error: `Fleet ${fleetId} tidak terdaftar` });
    }

    const result = await prisma.$transaction(async (tx) => {
      const defect = await tx.defectList.create({
        data: {
          fleetId,
          sumber: sumber || 'UNPLANNED',
          deskripsi,
          priority: (priority as PriorityLevel) || PriorityLevel.MEDIUM,
          segmentasi: (segmentasi as WorkSegmentation) || WorkSegmentation.RUNNING_REPAIR,
          dueDate: new Date(Date.now() + 14 * 86400000),
          status: 'OPEN'
        }
      });

      const wo = await tx.workOrder.create({
        data: {
          fleetId,
          defectId: defect.id,
          pekerjaan,
          segmentasi: (segmentasi as WorkSegmentation) || WorkSegmentation.RUNNING_REPAIR,
          status: OrderStatus.DRAFT,
          currentRole: actorRole
        }
      });

      await tx.orderTracking.create({
        data: {
          workOrderId: wo.id,
          fromStatus: OrderStatus.DRAFT,
          toStatus: OrderStatus.DRAFT,
          actorRole,
          actorId,
          notes: `Work Order dibuat dari temuan [${sumber || 'UNPLANNED'}]`
        }
      });

      if (segmentasi === WorkSegmentation.DOCKING) {
        await tx.dockingOrder.create({
          data: {
            fleetId,
            workOrderId: wo.id,
            targetDays: parseInt(targetDays) || 14,
            rkaPagu: parseFloat(rkaPagu) || 0
          }
        });
      }

      return wo;
    });

    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/:id/transition (transisi generik; target khusus wajib endpoint dedicated)
app.post('/api/orders/:id/transition', async (req: Request, res: Response) => {
  try {
    const { actorRole, actorId } = getActorContext(req);
    const { toStatus, notes } = req.body as { toStatus: OrderStatus; notes?: string };

    if (PROTECTED_TARGETS.includes(toStatus)) {
      return res.status(400).json({
        error: `Transisi ke ${toStatus} wajib melalui endpoint khusus (addendum / BAST)`
      });
    }

    const updated = await workflowService.transitionOrder({
      workOrderId: req.params.id,
      actorId,
      actorRole,
      toStatus,
      notes
    });

    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/docking/addendum (pengajuan Pekerjaan Tambahan, hanya saat EXECUTION)
app.post('/api/docking/addendum', async (req: Request, res: Response) => {
  try {
    const { actorRole, actorId } = getActorContext(req);
    const { dockingOrderId, uraian, estimasiBiaya } = req.body;

    const addendum = await dockingService.requestAddendum({
      dockingOrderId,
      uraian,
      estimasiBiaya: parseFloat(estimasiBiaya),
      actorId,
      actorRole
    });

    res.status(201).json(addendum);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/docking/addendum/:id/approve (SR TS jika <=10%, OMA/Dirtek jika >10%)
app.post('/api/docking/addendum/:id/approve', async (req: Request, res: Response) => {
  try {
    const { actorRole, actorId } = getActorContext(req);
    const updated = await dockingService.approveAddendum({
      addendumId: req.params.id,
      actorId,
      actorRole,
      catatan: req.body?.catatan
    });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/docking/addendum/:id/reject
app.post('/api/docking/addendum/:id/reject', async (req: Request, res: Response) => {
  try {
    const { actorRole, actorId } = getActorContext(req);
    const updated = await dockingService.rejectAddendum({
      addendumId: req.params.id,
      actorId,
      actorRole,
      catatan: req.body?.catatan
    });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/docking/milestone (Berita Acara SOP: Joint Survey / Naik Dok / Turun Dok / Sea Trial)
app.post('/api/docking/milestone', async (req: Request, res: Response) => {
  try {
    const { actorRole, actorId } = getActorContext(req);
    const { dockingOrderId, tipeBa, dokumenBaUrl } = req.body;

    const milestone = await dockingService.recordMilestone({
      dockingOrderId,
      tipeBa,
      dokumenBaUrl: dokumenBaUrl || `/uploads/ba_${String(tipeBa).toLowerCase()}.pdf`,
      actorId,
      actorRole
    });

    res.status(201).json(milestone);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/orders/:id/bast (BAST + Skor + Dokumen Foto oleh Jr TS / Kapal)
app.post('/api/orders/:id/bast', async (req: Request, res: Response) => {
  try {
    const { actorRole, actorId } = getActorContext(req);
    const { dokumenBastUrl, fotoUrl, perfScoreGalangan, catatan } = req.body;

    const bast = await dockingService.submitBast({
      workOrderId: req.params.id,
      dokumenBastUrl: dokumenBastUrl || '/uploads/bast_final.pdf',
      fotoUrl: fotoUrl || '/uploads/foto_selesai.jpg',
      perfScoreGalangan: parseFloat(perfScoreGalangan),
      catatan,
      actorId,
      actorRole
    });

    res.status(201).json(bast);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/pms
app.get('/api/pms', async (_req: Request, res: Response) => {
  try {
    const pmsList = await prisma.pMS.findMany({
      include: { fleet: true, equipment: true },
      orderBy: { tanggalJatuhTempo: 'asc' }
    });
    res.json(pmsList);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/smartsheet (dummy adapter)
app.post('/api/sync/smartsheet', async (_req: Request, res: Response) => {
  try {
    const fleets = await syncService.syncFleetMaster();
    const noonReports = await syncService.syncNoonReport();
    const pms = await syncService.syncPms();
    res.json({
      success: true,
      syncedFleets: fleets,
      syncedNoonReports: noonReports,
      syncedPms: pms,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
export let server: any = null;

if (!process.env.VERCEL) {
  server = app.listen(PORT, () => {
    console.log(`[Armada Fleet Server] running on http://localhost:${PORT}`);
  });
}

export { app, prisma };
