import { Test } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('AuthController', () => {
  let controller: AuthController;

  const mockRegister = jest.fn();
  const mockLogin = jest.fn();
  const mockGetCurrentUser = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            register: mockRegister,
            login: mockLogin,
            getCurrentUser: mockGetCurrentUser,
          },
        },
      ],
    }).compile();

    controller = moduleRef.get(AuthController);
  });

  it('delegates register to AuthService', async () => {
    const dto = { email: 'user@example.com', password: 'password123' };

    await controller.register(dto);

    expect(mockRegister).toHaveBeenCalledWith(dto);
  });

  it('delegates login to AuthService', async () => {
    const dto = { email: 'user@example.com', password: 'password123' };

    await controller.login(dto);

    expect(mockLogin).toHaveBeenCalledWith(dto);
  });

  it('delegates me to AuthService using the authenticated user id', async () => {
    await controller.me({ userId: 'user-1' });

    expect(mockGetCurrentUser).toHaveBeenCalledWith('user-1');
  });

  it('protects GET /auth/me with JwtAuthGuard', () => {
    const meMethod = Object.getOwnPropertyDescriptor(
      AuthController.prototype,
      'me',
    )?.value as ((...args: never[]) => unknown) | undefined;

    const guards = Reflect.getMetadata('__guards__', meMethod) as
      unknown[] | undefined;

    expect(guards).toBeDefined();
    expect(guards).toContain(JwtAuthGuard);
  });
});
