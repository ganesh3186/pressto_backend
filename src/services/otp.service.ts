import {inject, injectable} from '@loopback/core';
import {EmailService} from './email.service';

@injectable()
export class OtpService {
  constructor(
    @inject('services.email.send')
    public emailService: EmailService,
  ) {}

  generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
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
