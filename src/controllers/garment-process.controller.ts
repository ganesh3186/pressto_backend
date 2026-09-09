import {authenticate, AuthenticationBindings} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {get, param, post, requestBody, response} from '@loopback/rest';
import {securityId, UserProfile} from '@loopback/security';
import {authorize} from '../authorization';
import {ProcessService} from '../services/process.service';
import {StoreScopeService} from '../services/store-scope.service';

export class GarmentProcessController {
  constructor(
    @inject('services.process')
    private processService: ProcessService,
    @inject('services.store-scope')
    private storeScopeService: StoreScopeService,
  ) {}

  // ─── Init Process ─────────────────────────────────────────────────────────
  // Call once when garment status transitions to IN_PROCESS.
  // Creates all pending log rows for every service × step on this garment.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['processing:update']})
  @post('/garments/{id}/process/init')
  @response(200, {description: 'Process initialised — pending log rows created for all steps'})
  async initProcess(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    await this.storeScopeService.assertGarmentEditable(id, currentUser);
    return this.processService.initProcess(id, currentUser[securityId]);
  }

  // ─── Advance Process ──────────────────────────────────────────────────────
  // Advances one step:
  //   • Completes the current IN_PROGRESS step (if any).
  //   • Starts the next PENDING step.
  //   • When all steps are done, moves garment to QUALITY_CHECK.
  //
  // If QR_SCAN_REQUIRED=true (env), qrCode in the body is mandatory.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['processing:update']})
  @post('/garments/{id}/process/advance')
  @response(200, {description: 'Process advanced one step'})
  async advanceProcess(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              qrCode: {
                type: 'string',
                description: 'Scanned QR code value. Required when QR_SCAN_REQUIRED=true.',
              },
            },
          },
        },
      },
    })
    body: {qrCode?: string},
  ): Promise<object> {
    await this.storeScopeService.assertGarmentEditable(id, currentUser);
    return this.processService.advanceProcess(id, currentUser[securityId], body?.qrCode);
  }

  // ─── Complete All Steps ───────────────────────────────────────────────────
  // "Mark all processes done" — closes every remaining step in one call and
  // moves the garment to QUALITY_CHECK, instead of advancing step by step.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['processing:update']})
  @post('/garments/{id}/process/complete-all')
  @response(200, {description: 'All remaining process steps completed'})
  async completeAllProcesses(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              qrCode: {
                type: 'string',
                description: 'Scanned QR code value. Required when QR_SCAN_REQUIRED=true.',
              },
            },
          },
        },
      },
    })
    body?: {qrCode?: string},
  ): Promise<object> {
    await this.storeScopeService.assertGarmentEditable(id, currentUser);
    return this.processService.completeAllProcesses(id, currentUser[securityId], body?.qrCode);
  }

  // ─── Fast-Track to Ready (processing-disabled bypass) ────────────────────
  // Only permitted when PROCESSING_ENABLED=false (see getProcessingConfig
  // below) — auto-completes every remaining step and moves the garment
  // straight to ready, skipping the normal stage-by-stage advance/complete-all
  // flow entirely.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['processing:update']})
  @post('/garments/{id}/process/fast-track-ready')
  @response(200, {description: 'Garment fast-tracked straight to ready (processing-disabled bypass)'})
  async fastTrackToReady(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
    @requestBody({
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              qrCode: {
                type: 'string',
                description: 'Scanned QR/tag value. Required when QR_SCAN_REQUIRED=true.',
              },
            },
          },
        },
      },
    })
    body?: {qrCode?: string},
  ): Promise<object> {
    await this.storeScopeService.assertGarmentEditable(id, currentUser);
    return this.processService.fastTrackToReady(id, currentUser[securityId], body?.qrCode);
  }

  // ─── Processing Config ─────────────────────────────────────────────────────
  // Lets the admin panel know whether to show the fast-track-to-ready UI at
  // all, rather than inferring it from a failed call.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['processing:read']})
  @get('/garments/process/config')
  @response(200, {description: 'Processing pipeline configuration'})
  async getProcessingConfig(): Promise<object> {
    return this.processService.getConfig();
  }

  // ─── Reverse Step ─────────────────────────────────────────────────────────
  // Undoes the last completed process step — marks it back to in_progress.
  // If the garment had advanced to quality_check, it returns to in_process.

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['processing:update']})
  @post('/garments/{id}/process/reverse')
  @response(200, {description: 'Last completed step reversed'})
  async reverseStep(
    @inject(AuthenticationBindings.CURRENT_USER) currentUser: UserProfile,
    @param.path.string('id') id: string,
  ): Promise<object> {
    await this.storeScopeService.assertGarmentEditable(id, currentUser);
    return this.processService.reverseStep(id, currentUser[securityId]);
  }

  // ─── Process Status ───────────────────────────────────────────────────────

  @authenticate('jwt')
  @authorize({roles: ['super_admin'], permissions: ['processing:read']})
  @get('/garments/{id}/process-status')
  @response(200, {description: 'Full process status for a garment — all services and steps'})
  async getProcessStatus(@param.path.string('id') id: string): Promise<object> {
    return this.processService.getProcessStatus(id);
  }
}
