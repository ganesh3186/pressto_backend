import {inject, injectable} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {randomInt} from 'crypto';
import {UsersRepository} from '../repositories/users.repository';
import {EmailService} from './email.service';
import {BcryptHasher} from './hash.password.bcrypt';
import {WhatsAppService} from './whatsapp.service';

@injectable()
export class OtpService {
  constructor(
    @inject('services.email.send')
    public emailService: EmailService,
    @repository(UsersRepository)
    private usersRepository: UsersRepository,
    @inject('service.hasher')
    private hasher: BcryptHasher,
    @inject('services.whatsapp')
    private whatsAppService: WhatsAppService,
  ) {}

  generateOtp(): string {
    return randomInt(100000, 1000000).toString();
  }

  /** Caller resolves the customer/rider account before issuing its login code. */
  async sendLoginOtp(user: {id: string; phone: string; countryCode: string}) {
    const otp = this.generateOtp();
    const hashedOtp = await this.hasher.hashPassword(otp);
    const expiry = new Date(Date.now() + 10 * 60 * 1000);
    await this.usersRepository.updateById(user.id, {
      loginOtp: hashedOtp,
      loginOtpExpires: expiry,
    });
    const accepted = await this.whatsAppService.sendTemplateMessage({
      to: user.countryCode + user.phone,
      templateId: 'pulse_login_otp_221026',
      bodyParams: [otp],
    });
    if (!accepted) {
      throw new HttpErrors.ServiceUnavailable(
        'Could not send the login code on WhatsApp. Please try again later.',
      );
    }
    return {message: 'Login code requested on WhatsApp', expiresInSeconds: 600};
  }

  async sendOtpEmail(email: string, otp: string): Promise<void> {
    const mailOptions = {
      to: email,
      subject: 'Password Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #1976d2; text-align: center;">Pressto Verification</h2>
          <p style="font-size: 16px; color: #333;">Hello,</p>
          <p style="font-size: 16px; color: #333;">You have requested to reset your password. Please use the following 6-digit verification code to proceed.</p>
          <div style="background-color: #f5f5f5; padding: 20px; text-align: center; border-radius: 4px; margin: 20px 0;">
            <h1 style="color: #1976d2; margin: 0; letter-spacing: 5px;">${otp}</h1>
          </div>
          <p style="font-size: 14px; color: #666;">This code is valid for 10 minutes. If you did not request a password reset, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;" />
          <p style="font-size: 12px; color: #999; text-align: center;">© 2024 Pressto. All rights reserved.</p>
        </div>
      `,
    };

    await this.emailService.sendMail(mailOptions);
  }
}
