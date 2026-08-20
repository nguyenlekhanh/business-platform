import { Test } from '@nestjs/testing';
import { PasswordHashingService } from './password-hashing.service';

describe('PasswordHashingService', () => {
  let service: PasswordHashingService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PasswordHashingService],
    }).compile();

    service = moduleRef.get(PasswordHashingService);
  });

  it('hashes a password with argon2id and never returns the plaintext', async () => {
    const password = 's3cretPass!123';

    const hash = await service.hash(password);

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(password);
  });

  it('produces a different hash for each password', async () => {
    const first = await service.hash('same-password');
    const second = await service.hash('same-password');

    expect(first).not.toBe(second);
  });

  it('verifies the correct password', async () => {
    const password = 'correct-horse-battery-staple';
    const hash = await service.hash(password);

    await expect(service.verify(hash, password)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('correct-password');

    await expect(service.verify(hash, 'wrong-password')).resolves.toBe(false);
  });
});
