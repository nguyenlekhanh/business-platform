import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsEnum } from 'class-validator';
import { OrderStatus } from '@prisma/client';
import { PageQueryDto } from '../../common/pagination/pagination-query.dto';

export class OrderItemInputDto {
  @IsString()
  @IsNotEmpty()
  variantId!: string;

  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity!: number;
}

/**
 * Create order payload — Phase 3 U6.
 * Either provide `items` for direct order, or send empty/no items to checkout
 * own OPEN cart. `customerId` optional, same-tenant validated.
 * Status is never client-writable (whitelist rejects it).
 */
export class CreateOrderDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items?: OrderItemInputDto[];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  customerId?: string;
}

export class OrderListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}
