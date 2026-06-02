/* eslint-disable @typescript-eslint/return-await */
import * as nodemailer from 'nodemailer';
// eslint-disable-next-line @typescript-eslint/naming-convention
import SITE_SETTINGS from '../utils/config';
export interface EmailManager<T = Object> {
  sendMail(mailObj: object): Promise<T>;
}

export class EmailService {
  constructor() { }

  async sendMail(mailObj: object): Promise<object> {
    const transporter = nodemailer.createTransport(SITE_SETTINGS.email);

    return await transporter.sendMail({
      from: SITE_SETTINGS.fromMail,
      ...mailObj,
    });
  }
}
