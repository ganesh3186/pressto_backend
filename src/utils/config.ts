const SITE_SETTINGS = {
  email: {
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: process.env.EMAIL_PORT === '465',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false,
    },
    debug: false,
    logger: false,
  },
  fromMail: process.env.EMAIL_FROM || process.env.EMAIL_USER,
};
export default SITE_SETTINGS;
