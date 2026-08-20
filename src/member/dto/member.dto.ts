import { IsIn } from 'class-validator';
import { MembershipStatus } from '@prisma/client';

/**
 * Status transitions allowed by the membership administration endpoint.
 * INVITED is excluded: invitation tokens are not part of this phase, so a
 * member can only be activated or suspended. The service enforces the
 * security invariants (self-change, owner protection, last-active-owner).
 */
export class UpdateMemberStatusDto {
  @IsIn([MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED], {
    message: 'status must be one of: ACTIVE, SUSPENDED',
  })
  status!: MembershipStatus;
}
