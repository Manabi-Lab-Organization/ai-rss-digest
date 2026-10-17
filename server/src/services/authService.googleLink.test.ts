import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  selectQueue: [] as any[][],
  updates: [] as any[],
  inserts: [] as any[],
  updateReturning: [{ id: 1 }] as any[],
}));

vi.mock('../db/index.js', () => {
  const makeSelect = () => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      for: () => chain,
      limit: () => Promise.resolve(h.selectQueue.shift() ?? []),
    };
    return chain;
  };
  const update = () => ({
    set: (values: any) => ({
      where: () => {
        h.updates.push(values);
        const p: any = Promise.resolve();
        p.returning = () => Promise.resolve(h.updateReturning);
        return p;
      },
    }),
  });
  const insert = () => ({
    values: (values: any) => {
      h.inserts.push(values);
      return {
        returning: () => Promise.resolve([{ id: 100, ...values }]),
        onConflictDoNothing: () => {
          const p: any = Promise.resolve();
          p.returning = () => Promise.resolve([{ id: 1 }]);
          return p;
        },
      };
    },
  });
  const db: any = { select: makeSelect, update, insert, execute: async () => {} };
  db.transaction = async (cb: any) => cb(db);
  return { db, pool: {} };
});

vi.mock('./emailService.js', () => ({ sendPasswordResetEmail: vi.fn(async () => {}) }));
vi.mock('./authSessionService.js', () => ({ invalidateAllUserAccess: vi.fn(async () => {}) }));

import {
  findExistingByGoogle,
  findOrCreateByGoogle,
  isGoogleEmailVerified,
  register,
  GoogleLinkNotAllowedError,
  GoogleAccountMismatchError,
  InviteRequiredError,
  SETUP_CODE_REQUIRED_MESSAGE,
} from './authService.js';
import { hasSetupCode, resetSetupCodeForTest, verifySetupCode } from './setupCode.js';

const SETUP = 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ';

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    email: 'yamada@example.com',
    passwordHash: '$2a$12$samplehash',
    googleId: null,
    emailVerifiedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  h.selectQueue = [];
  h.updates = [];
  h.inserts = [];
  h.updateReturning = [{ id: 1 }];
  resetSetupCodeForTest(SETUP);
});

describe('isGoogleEmailVerified', () => {
  it('Google の情報でメールが確認済みとされているときだけ true を返す', () => {
    expect(isGoogleEmailVerified({ email_verified: true })).toBe(true);
    expect(isGoogleEmailVerified({ email_verified: 'true' })).toBe(true);
    expect(isGoogleEmailVerified({ email_verified: false })).toBe(false);
    expect(isGoogleEmailVerified({ email_verified: 'false' })).toBe(false);
    expect(isGoogleEmailVerified({})).toBe(false);
    expect(isGoogleEmailVerified(null)).toBe(false);
  });
});

describe('findExistingByGoogle', () => {
  it('メールが確認されていないパスワード登録のアカウントには結び付けない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([user()]);
    await expect(findExistingByGoogle('google-sub-yamada', 'yamada@example.com')).rejects.toBeInstanceOf(
      GoogleLinkNotAllowedError,
    );
    expect(h.updates).toHaveLength(0);
  });

  it('メールが確認済みのアカウントには結び付ける', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([user({ emailVerifiedAt: new Date('2054-01-01') })]);
    const result = await findExistingByGoogle('google-sub-yamada', 'Yamada@Example.com');
    expect(result?.id).toBe(1);
    expect(result?.googleId).toBe('google-sub-yamada');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].googleId).toBe('google-sub-yamada');
  });

  it('すでに別の Google アカウントと結び付いていれば置き換えない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([user({ googleId: 'google-sub-suzuki', emailVerifiedAt: new Date() })]);
    await expect(findExistingByGoogle('google-sub-yamada', 'yamada@example.com')).rejects.toBeInstanceOf(
      GoogleAccountMismatchError,
    );
    expect(h.updates).toHaveLength(0);
  });

  it('同時に別の Google アカウントが先に結び付いたときも置き換えない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([user({ emailVerifiedAt: new Date() })]);
    h.updateReturning = [];
    await expect(findExistingByGoogle('google-sub-yamada', 'yamada@example.com')).rejects.toBeInstanceOf(
      GoogleAccountMismatchError,
    );
  });

  it('大文字と小文字だけが違うアカウントが複数あれば結び付けない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([
      user({ emailVerifiedAt: new Date() }),
      user({ id: 2, email: 'Yamada@example.com', emailVerifiedAt: new Date() }),
    ]);
    await expect(findExistingByGoogle('google-sub-yamada', 'yamada@example.com')).rejects.toBeInstanceOf(
      GoogleLinkNotAllowedError,
    );
    expect(h.updates).toHaveLength(0);
  });

  it('Google の ID で見つかればそれを返し、メールが未確認なら確認済みにする', async () => {
    h.selectQueue.push([user({ googleId: 'google-sub-yamada' })]);
    const result = await findExistingByGoogle('google-sub-yamada', 'yamada@example.com');
    expect(result?.id).toBe(1);
    expect(result?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toHaveProperty('emailVerifiedAt');
    expect(h.updates[0]).not.toHaveProperty('googleId');
  });

  it('ID でもメールでも見つからなければ null を返す', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([]);
    expect(await findExistingByGoogle('google-sub-sato', 'sato@example.com')).toBeNull();
  });
});

describe('findOrCreateByGoogle', () => {
  it('新しく作るときはメールを小文字にし、確認済みにしておく', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    const { user: created, created: isNew } = await findOrCreateByGoogle('google-sub-sato', 'Sato.Hanako@Example.com', 'Sato', undefined, SETUP);
    expect(isNew).toBe(true);
    expect(created.email).toBe('sato.hanako@example.com');
    const userInsert = h.inserts.find((v) => 'googleId' in v);
    expect(userInsert.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('メールが未確認のアカウントがあれば、新しく作らずにエラーにする', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([user()]);
    await expect(findOrCreateByGoogle('google-sub-yamada', 'yamada@example.com')).rejects.toBeInstanceOf(
      GoogleLinkNotAllowedError,
    );
    expect(h.inserts).toHaveLength(0);
  });
});

describe('register', () => {
  it('メールは小文字で保存し、確認済みにはしない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    const created = await register('Tanaka.Ichiro@Example.com', 'password123', undefined, undefined, SETUP);
    expect(created.email).toBe('tanaka.ichiro@example.com');
    const userInsert = h.inserts.find((v) => 'passwordHash' in v);
    expect(userInsert.emailVerifiedAt).toBeUndefined();
  });

  it('最初に登録した人は管理者になる', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    await register('tanaka@example.com', 'password123', undefined, undefined, SETUP);
    expect(h.inserts.find((v) => 'passwordHash' in v).role).toBe('admin');
  });

  it('INITIAL_ADMIN_EMAIL が決まっていれば、最初の登録はそのアドレスだけを受け付ける', async () => {
    process.env.INITIAL_ADMIN_EMAIL = 'Owner@Example.com';
    try {
      h.selectQueue.push([]);
      h.selectQueue.push([{ count: 0 }]);
      await expect(register('takahashi@example.com', 'password123', undefined, undefined, SETUP)).rejects.toThrow('INITIAL_ADMIN_EMAIL');
      expect(h.inserts).toHaveLength(0);
      h.selectQueue.push([]);
      h.selectQueue.push([{ count: 0 }]);
      await register('owner@example.com', 'password123', undefined, undefined, SETUP);
      expect(h.inserts.find((v) => 'passwordHash' in v).role).toBe('admin');
    } finally {
      delete process.env.INITIAL_ADMIN_EMAIL;
    }
  });

  it('最初の管理者は、初期設定コードが無い・違うときは登録できない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    await expect(register('tanaka@example.com', 'password123', undefined)).rejects.toThrow(SETUP_CODE_REQUIRED_MESSAGE);
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    await expect(register('tanaka@example.com', 'password123', undefined, undefined, 'WRONG-CODE')).rejects.toThrow(SETUP_CODE_REQUIRED_MESSAGE);
    expect(h.inserts).toHaveLength(0);
  });

  it('初期設定コードは大文字小文字と区切りの違いを問わず受け付け、使ったら無効になる', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    await register('tanaka@example.com', 'password123', undefined, undefined, SETUP.toLowerCase().replace(/-/g, ' '));
    expect(h.inserts.find((v) => 'passwordHash' in v).role).toBe('admin');
    expect(hasSetupCode()).toBe(false);
    expect(verifySetupCode(SETUP)).toBe(false);
  });

  it('コードがまだ作られていなければ、作り直してログに出し、登録は断る', async () => {
    resetSetupCodeForTest(null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      h.selectQueue.push([]);
      h.selectQueue.push([{ count: 0 }]);
      await expect(register('tanaka@example.com', 'password123', undefined, undefined, SETUP)).rejects.toThrow(SETUP_CODE_REQUIRED_MESSAGE);
      expect(hasSetupCode()).toBe(true);
      expect(logSpy.mock.calls.some(([line]) => String(line).includes('初期設定コード:'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('Google での最初の登録も、初期設定コードが無ければ断る', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    await expect(findOrCreateByGoogle('google-sub-sato', 'sato@example.com', 'Sato')).rejects.toThrow(SETUP_CODE_REQUIRED_MESSAGE);
    expect(h.inserts).toHaveLength(0);
  });

  it('2人目からは招待コードが無ければ登録できない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 1 }]);
    await expect(register('suzuki@example.com', 'password123', undefined)).rejects.toBeInstanceOf(InviteRequiredError);
    expect(h.inserts).toHaveLength(0);
  });

  it('2人目でも招待コードがあれば一般の利用者として登録し、コードを使ったことにする', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 1 }]);
    h.selectQueue.push([{ maxUses: null, usedCount: 0, expiresAt: null, isActive: true }]);
    await register('suzuki@example.com', 'password123', undefined, 'sample-code');
    expect(h.inserts.find((v) => 'passwordHash' in v).role).toBe('user');
    expect(h.inserts.find((v) => 'code' in v)).toMatchObject({ code: 'SAMPLE-CODE' });
  });

  it('大文字と小文字だけが違う同じアドレスがあれば、登録済みとして断る', async () => {
    h.selectQueue.push([{ id: 1 }]);
    await expect(register('YAMADA@example.com', 'password123', undefined)).rejects.toThrow(
      'このメールアドレスはすでに登録されています',
    );
  });
});
