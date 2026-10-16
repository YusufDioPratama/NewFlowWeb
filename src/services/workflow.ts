import { PrismaClient, Role, OrderStatus } from '@prisma/client';

// Matriks transisi: from -> to -> daftar role yang berhak.
// Selaras ERD: Kapal/Jr TS input -> Sr TS approve -> MRP cek stock
// -> (Workshop | Regional: Cost Estimate -> PR -> Penawaran PBJ) -> Eksekusi
// -> Selesai -> BAST (Jr TS/Kapal) -> Keuangan -> Arsip (OMA).
export const TRANSITIONS: Record<OrderStatus, Partial<Record<OrderStatus, Role[]>>> = {
  [OrderStatus.DRAFT]: {
    [OrderStatus.SUBMITTED_JR_TS]: [Role.JR_TS, Role.KAPAL]
  },
  [OrderStatus.SUBMITTED_JR_TS]: {
    [OrderStatus.APPROVED_SR_TS]: [Role.SR_TS],
    [OrderStatus.REJECTED]: [Role.SR_TS]
  },
  [OrderStatus.APPROVED_SR_TS]: {
    [OrderStatus.MRP_STOCK_CHECK]: [Role.MRP]
  },
  [OrderStatus.MRP_STOCK_CHECK]: {
    [OrderStatus.ALLOCATED_WORKSHOP]: [Role.MRP], // stock ada -> fasilitas internal
    [OrderStatus.REGIONAL_COST_ESTIMATE]: [Role.MRP] // stock tidak ada -> pengadaan regional
  },
  [OrderStatus.ALLOCATED_WORKSHOP]: {
    [OrderStatus.EXECUTION]: [Role.WORKSHOP]
  },
  [OrderStatus.REGIONAL_COST_ESTIMATE]: {
    [OrderStatus.REGIONAL_PR_PBJ]: [Role.REGIONAL]
  },
  [OrderStatus.REGIONAL_PR_PBJ]: {
    [OrderStatus.EXECUTION]: [Role.REGIONAL]
  },
  [OrderStatus.EXECUTION]: {
    [OrderStatus.ADDENDUM_REQUESTED]: [Role.JR_TS, Role.SR_TS],
    [OrderStatus.WORK_COMPLETED]: [Role.WORKSHOP, Role.REGIONAL, Role.JR_TS, Role.SR_TS]
  },
  [OrderStatus.ADDENDUM_REQUESTED]: {
    [OrderStatus.ADDENDUM_APPROVED]: [Role.SR_TS, Role.OMA_ADMIN],
    [OrderStatus.EXECUTION]: [Role.SR_TS, Role.OMA_ADMIN] // addendum ditolak -> lanjut eksekusi
  },
  [OrderStatus.ADDENDUM_APPROVED]: {
    [OrderStatus.EXECUTION]: [Role.JR_TS, Role.SR_TS]
  },
  [OrderStatus.WORK_COMPLETED]: {
    [OrderStatus.BAST_SUBMITTED]: [Role.JR_TS, Role.KAPAL]
  },
  [OrderStatus.BAST_SUBMITTED]: {
    [OrderStatus.PAYMENT_PROCESSED]: [Role.KEUANGAN]
  },
  [OrderStatus.PAYMENT_PROCESSED]: {
    [OrderStatus.COMPLETED]: [Role.KEUANGAN, Role.OMA_ADMIN]
  },
  [OrderStatus.REJECTED]: {
    [OrderStatus.DRAFT]: [Role.JR_TS, Role.KAPAL]
  },
  [OrderStatus.COMPLETED]: {}
};

// Endpoint khusus (bukan transisi generik): alasan bisnis harus divalidasi di service terkait
export const PROTECTED_TARGETS: OrderStatus[] = [
  OrderStatus.ADDENDUM_REQUESTED,
  OrderStatus.ADDENDUM_APPROVED,
  OrderStatus.BAST_SUBMITTED
];

export const ADMIN_ROLES: Role[] = [Role.OMA_ADMIN, Role.OMA_2];

export interface TransitionContext {
  workOrderId: string;
  actorId: string;
  actorRole: Role;
  toStatus: OrderStatus;
  notes?: string;
}

export class WorkflowService {
  constructor(private prisma: PrismaClient) {}

  isAllowed(from: OrderStatus, to: OrderStatus, role: Role): boolean {
    const targets = TRANSITIONS[from] || {};
    const validTarget = Object.prototype.hasOwnProperty.call(targets, to);
    if (!validTarget) return false;
    if (ADMIN_ROLES.includes(role)) return true;
    const roles = targets[to] || [];
    return roles.includes(role);
  }

  availableTransitions(status: OrderStatus, role: Role): OrderStatus[] {
    const targets = TRANSITIONS[status] || {};
    return (Object.keys(targets) as OrderStatus[]).filter((to) => this.isAllowed(status, to, role));
  }

  async transitionOrder(ctx: TransitionContext) {
    const order = await this.prisma.workOrder.findUnique({
      where: { id: ctx.workOrderId }
    });

    if (!order) {
      throw new Error(`Order ${ctx.workOrderId} not found`);
    }

    if (order.status === ctx.toStatus) {
      throw new Error(`Order sudah berada pada status ${ctx.toStatus}`);
    }

    const targets = TRANSITIONS[order.status] || {};
    if (!Object.prototype.hasOwnProperty.call(targets, ctx.toStatus)) {
      throw new Error(`Invalid transition: tidak ada jalur dari ${order.status} ke ${ctx.toStatus}`);
    }

    if (!ADMIN_ROLES.includes(ctx.actorRole)) {
      const allowed = targets[ctx.toStatus] || [];
      if (!allowed.includes(ctx.actorRole)) {
        throw new Error(
          `Unauthorized: Role ${ctx.actorRole} tidak berhak menjalankan ${order.status} -> ${ctx.toStatus}. Role berhak: ${allowed.join(', ')}`
        );
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const wo = await tx.workOrder.update({
        where: { id: ctx.workOrderId },
        data: {
          status: ctx.toStatus,
          currentRole: ctx.actorRole
        }
      });

      await tx.orderTracking.create({
        data: {
          workOrderId: ctx.workOrderId,
          fromStatus: order.status,
          toStatus: ctx.toStatus,
          actorRole: ctx.actorRole,
          actorId: ctx.actorId,
          notes: ctx.notes ?? null
        }
      });

      if (ctx.toStatus === OrderStatus.PAYMENT_PROCESSED) {
        await tx.bASTRecord.updateMany({
          where: { workOrderId: ctx.workOrderId },
          data: { keuanganStatus: 'PAID' }
        });
      }

      return wo;
    });

    return updated;
  }

  async getOrderTrackingHistory(workOrderId: string) {
    return this.prisma.orderTracking.findMany({
      where: { workOrderId },
      orderBy: { timestamp: 'asc' }
    });
  }
}
