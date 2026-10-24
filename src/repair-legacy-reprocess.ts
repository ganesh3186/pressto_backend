import {IsolationLevel} from '@loopback/repository';
import {presstoBackendApplication} from './application';
import {PresstoDataSource} from './datasources/pressto.datasource';
import {ApprovalRequestStatus} from './models/approval-request-status.enum';
import {ApprovalRequestType} from './models/approval-request-type.enum';
import {OrderStatus} from './models/order-status.enum';
import {ApprovalRequestRepository, OrderRepository} from './repositories';
import {ApprovalService} from './services/approval.service';

type Candidate = {id: string; entitytype: string; entityid: string; requestedby: string};

export async function repairLegacyReprocess(apply = false): Promise<void> {
  const app = new presstoBackendApplication();
  await app.boot();
  const dataSource = await app.get<PresstoDataSource>('datasources.pressto');
  const approvalRepo = await app.get<ApprovalRequestRepository>('repositories.ApprovalRequestRepository');
  const orderRepo = await app.get<OrderRepository>('repositories.OrderRepository');
  const approvalService = await app.get<ApprovalService>('services.approval');
  const {v4} = await import('uuid');
  try {
    const candidates = await dataSource.execute(
      `SELECT a.id, a.entitytype, a.entityid, a.requestedby
       FROM public.approval_request a
       WHERE a.type = 'reprocess' AND a.status IN ('pending', 'approved')
         AND ((a.entitytype = 'order' AND a.metadata->>'reworkOrderId' IS NULL)
           OR (a.entitytype = 'garment' AND EXISTS (
             SELECT 1 FROM public.garment g WHERE g.id = a.entityid AND g.status = 'on_hold'
           )))
       ORDER BY a.createdat, a.id`,
    ) as Candidate[];
    const orderCount = candidates.filter(candidate => candidate.entitytype === 'order').length;
    console.log(`${candidates.length} legacy reprocess request(s) ${apply ? 'to repair' : 'eligible (dry run)'}: ${orderCount} order, ${candidates.length - orderCount} garment.`);
    if (!apply) return;

    let unresolved = 0;
    for (const candidate of candidates) {
      const tx = await dataSource.beginTransaction({isolationLevel: IsolationLevel.READ_COMMITTED});
      try {
        if (candidate.entitytype === 'order') {
          await dataSource.execute('SELECT id FROM public.orders WHERE id = $1 FOR UPDATE', [candidate.entityid], {transaction: tx});
          const request = await approvalRepo.findById(candidate.id, undefined, {transaction: tx});
          if (request.metadata?.reworkOrderId) { await tx.rollback(); continue; }
          const requestedIds = request.metadata?.garmentIds;
          const requested = new Set(Array.isArray(requestedIds) ? requestedIds as string[] : []);
          const siblings = await approvalRepo.find({where: {
            type: ApprovalRequestType.REPROCESS, entityType: 'order', entityId: candidate.entityid,
          }}, {transaction: tx});
          let overlapping = false;
          for (const sibling of siblings) {
            const ticketId = sibling.metadata?.reworkOrderId;
            if (!ticketId) continue;
            const ticket = await orderRepo.findOne({where: {id: String(ticketId), isDeleted: false}}, {transaction: tx});
            if (!ticket || [OrderStatus.DELIVERED, OrderStatus.CANCELLED, OrderStatus.RETURNED].includes(ticket.status as OrderStatus)) continue;
            const siblingIds = sibling.metadata?.garmentIds;
            if ((Array.isArray(siblingIds) ? siblingIds : []).some(id => requested.has(id))) {
              overlapping = true;
              break;
            }
          }
          if (overlapping) {
            await tx.rollback();
            unresolved++;
            console.log(`Skipped overlapping legacy order request ${candidate.id}.`);
            continue;
          }
          await approvalService.createPostDeliveryReprocessOrder(request, request.requestedBy, tx);
          await tx.commit();
          await approvalService.notifyReprocessPickupRequired(request)
            .catch(err => console.error('Pickup notification failed:', err));
        } else {
          await dataSource.execute('SELECT id FROM public.garment WHERE id = $1 FOR UPDATE', [candidate.entityid], {transaction: tx});
          const otherPending = await approvalRepo.findOne({where: {
            entityType: 'garment', entityId: candidate.entityid,
            status: ApprovalRequestStatus.PENDING, type: {neq: ApprovalRequestType.REPROCESS},
          }}, {transaction: tx});
          if (otherPending) {
            await tx.rollback();
            unresolved++;
            console.log(`Skipped garment ${candidate.entityid} with another pending approval.`);
            continue;
          }
          const updated = await dataSource.execute(
            "UPDATE public.garment SET status = 'in_process' WHERE id = $1 AND status = 'on_hold' RETURNING id",
            [candidate.entityid], {transaction: tx},
          ) as {id: string}[];
          if (!updated.length) { await tx.rollback(); continue; }
          await dataSource.execute(
            `UPDATE public.garment_process_log SET status = 'pending', startedat = NULL,
             startedby = NULL, completedat = NULL, completedby = NULL, qrscanned = false
             WHERE garmentid = $1`,
            [candidate.entityid], {transaction: tx},
          );
          await dataSource.execute(
            `INSERT INTO public.garment_status_history
             (id, garmentid, status, changedat, changedby, remarks)
             VALUES ($1, $2, 'in_process', NOW(), $3, $4)`,
            [v4(), candidate.entityid, candidate.requestedby,
              `Reprocess requested — legacy request ${candidate.id} started; approval is audit only`],
            {transaction: tx},
          );
          await tx.commit();
        }
        console.log(`Repaired ${candidate.entitytype} request ${candidate.id}.`);
      } catch (error) {
        await tx.rollback();
        unresolved++;
        console.error(`Could not repair request ${candidate.id}:`, error);
      }
    }
    if (unresolved) throw new Error(`${unresolved} legacy reprocess request(s) still need manual review.`);
  } finally {
    await dataSource.disconnect();
  }
}

if (require.main === module) {
  repairLegacyReprocess(process.argv.includes('--apply'))
    .then(() => process.exit(0))
    .catch(error => { console.error('Legacy reprocess repair failed:', error); process.exit(1); });
}
