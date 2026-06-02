import {compare, genSalt, hash} from 'bcryptjs';

interface PasswordHasher<T = string> {
  hashPassword(password: T): Promise<T>;
  comparePassword(providedPassword: T, storedPassword: T): Promise<boolean>;
}

export class BcryptHasher implements PasswordHasher<string> {

  async comparePassword(
    providedPassword: string,
    storedPassword: string,
  ): Promise<boolean> {
    const passwordMatched = await compare(providedPassword, storedPassword);
    return passwordMatched;
  }

  round = 10;
  async hashPassword(password: string) {
    const salt = await genSalt(this.round);
    return hash(password, salt);
  }

  // get random password
    async generateRandomPassword(){
    const length = Math.floor(Math.random() * 2) + 9;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';

    for (let i = 0; i < length; i++) {
      const index = Math.floor(Math.random() * chars.length);
      password += chars[index];
    }

    return password;
  }
}
