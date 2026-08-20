import { HttpException, HttpStatus } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  const logger = {
    error: jest.fn(),
    warn: jest.fn(),
  };

  const filter = new AllExceptionsFilter(logger as unknown as Logger);

  const request = {
    method: 'GET',
    url: '/unknown',
    originalUrl: '/unknown',
    ip: '127.0.0.1',
  };

  const json = jest.fn();
  const response = {
    status: jest.fn().mockReturnValue({ json }),
  };

  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is defined', () => {
    expect(filter).toBeDefined();
  });

  it('returns a structured 404 for unknown routes', () => {
    filter.catch(
      new HttpException(
        { message: 'Cannot GET /unknown', error: 'Not Found' },
        HttpStatus.NOT_FOUND,
      ),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Cannot GET /unknown',
        error: 'Not Found',
        path: '/unknown',
        method: 'GET',
      }),
    );
    const calls = json.mock.calls as unknown[][];
    const body = calls[0]?.[0] as Record<string, unknown>;
    expect(body).toHaveProperty('timestamp');
  });

  it('returns a structured 500 for unknown errors', () => {
    filter.catch(new Error('boom'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        message: 'Internal server error',
        error: 'InternalServerError',
        path: '/unknown',
        method: 'GET',
      }),
    );
  });

  it('logs 5xx responses as errors', () => {
    filter.catch(new Error('boom'), host);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs 4xx responses as warnings without a stack trace', () => {
    filter.catch(new HttpException('Not allowed', HttpStatus.FORBIDDEN), host);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('uses the message from the exception response object', () => {
    filter.catch(
      new HttpException(
        { message: ['name should not be empty'], error: 'Bad Request' },
        HttpStatus.BAD_REQUEST,
      ),
      host,
    );

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: ['name should not be empty'],
      }),
    );
  });
});
