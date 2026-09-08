import { AuthenticationComponent, registerAuthenticationStrategy } from '@loopback/authentication';
import { BootMixin } from '@loopback/boot';
import { ApplicationConfig } from '@loopback/core';
import { RepositoryMixin } from '@loopback/repository';
import { RestApplication } from '@loopback/rest';
import {
  RestExplorerBindings,
  RestExplorerComponent,
} from '@loopback/rest-explorer';
import { ServiceMixin } from '@loopback/service-proxy';
import multer from 'multer';
import path from 'path';
import { JWTStrategy } from './authentication-strategy/jwt-strategy';
import { EmailManagerBindings, FILE_UPLOAD_SERVICE, STORAGE_DIRECTORY } from './keys';
import { MySequence } from './sequence';
import { EmailService } from './services/email.service';
import { BcryptHasher } from './services/hash.password.bcrypt';
import { JWTService } from './services/jwt-service';
import { RbacService } from './services/rbac.service';
import { MyUserService } from './services/user-service';
import { MediaService } from './services/media.service';
import { WalletService } from './services/wallet.service';
import { SecurityDepositService } from './services/security-deposit.service';
import { OtpService } from './services/otp.service';
import { CustomerAddressService } from './services/customer-address.service';
import { CustomerContactService } from './services/customer-contact.service';
import { CustomerPhoneService } from './services/customer-phone.service';
import { OrderService } from './services/order.service';
import { ProcessService } from './services/process.service';
import { ApprovalService } from './services/approval.service';
import { ReprocessService } from './services/reprocess.service';
import { AuditService } from './services/audit.service';
import { StoreScopeService } from './services/store-scope.service';
import { CouponService } from './services/coupon.service';
import { CustomerPreferenceService } from './services/customer-preference.service';
import { PettyCashService } from './services/petty-cash.service';
import { RiderAssignmentService } from './services/rider-assignment.service';
import { RazorpayService } from './services/razorpay.service';

export { ApplicationConfig };

export class presstoBackendApplication extends BootMixin(
  ServiceMixin(RepositoryMixin(RestApplication)),
) {
  constructor(options: ApplicationConfig = {}) {
    super(options);

    this.component(AuthenticationComponent);

    // Set up the custom sequence
    this.sequence(MySequence);
    this.setUpBinding();

    // Set up default home page
    this.static('/', path.join(__dirname, '../public'));

    // Customize @loopback/rest-explorer configuration here
    this.configure(RestExplorerBindings.COMPONENT).to({
      path: '/explorer',
    });
    this.component(RestExplorerComponent);
    this.configureFileUpload(options.fileStorageDirectory);
    registerAuthenticationStrategy(this, JWTStrategy);

    this.projectRoot = __dirname;
    // Customize @loopback/boot Booter Conventions here
    this.bootOptions = {
      controllers: {
        // Customize ControllerBooter Conventions here
        dirs: ['controllers'],
        extensions: ['.controller.js'],
        nested: true,
      },
    };
  }

  setUpBinding(): void {
    this.bind('service.hasher').toClass(BcryptHasher);
    this.bind('services.rbac').toClass(RbacService);
    this.bind('jwt.secret').to(process.env.JWT_SECRET!);
    this.bind('jwt.expiresIn').to(process.env.JWT_EXPIRES_IN ?? '7h');
    this.bind('service.jwt.service').toClass(JWTService);
    this.bind('service.user.service').toClass(MyUserService);
    this.bind('service.media.service').toClass(MediaService);
    this.bind(EmailManagerBindings.SEND_MAIL).toClass(EmailService);
    this.bind('services.wallet').toClass(WalletService);
    this.bind('services.security-deposit').toClass(SecurityDepositService);
    this.bind('services.OtpService').toClass(OtpService);
    this.bind('services.customer-address').toClass(CustomerAddressService);
    this.bind('services.customer-contact').toClass(CustomerContactService);
    this.bind('services.customer-phone').toClass(CustomerPhoneService);
    this.bind('services.order').toClass(OrderService);
    this.bind('services.process').toClass(ProcessService);
    this.bind('services.approval').toClass(ApprovalService);
    this.bind('services.reprocess').toClass(ReprocessService);
    this.bind('services.audit').toClass(AuditService);
    this.bind('services.store-scope').toClass(StoreScopeService);
    this.bind('services.coupon').toClass(CouponService);
    this.bind('services.customer-preference').toClass(CustomerPreferenceService);
    this.bind('services.petty-cash').toClass(PettyCashService);
    this.bind('services.rider-assignment').toClass(RiderAssignmentService);
    this.bind('services.razorpay').toClass(RazorpayService);
  }

  protected configureFileUpload(destination?: string) {
    destination = destination ?? path.join(__dirname, '../.sandbox');
    this.bind(STORAGE_DIRECTORY).to(destination);

    const multerOptions: multer.Options = {
      storage: multer.diskStorage({
        destination,
        filename: (req, file, cb) => {
          const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
          const fileName = `${timestamp}_${file.originalname}`;
          cb(null, fileName);
        },
      }),
    };

    this.configure(FILE_UPLOAD_SERVICE).to(multerOptions);
  }
}
