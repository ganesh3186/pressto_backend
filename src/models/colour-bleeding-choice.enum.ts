// A customer's stored default for how a colour-bleeding risk found during
// inspection should be handled — shown as a remark to staff, not (yet)
// wired into the approval workflow itself.
export enum ColourBleedingChoice {
  ASK_EVERY_TIME = 'ask_every_time',
  ACCEPT_RISK_AND_PROCESS = 'accept_risk_and_process',
  RETURN_UNPROCESSED = 'return_unprocessed',
}
