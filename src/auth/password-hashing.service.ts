import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordHashingService {
  /**
   * Hashes a plaintext password with Argon2id. The plaintext is never stored
   * or returned.
   */
  async hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  /** Verifies a plaintext password against a stored Argon2id hash. */
  async verify(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }
}
