export type Errors<K extends string = string> = Partial<Record<K, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const isEmail = (s: string): boolean => EMAIL.test(s.trim()) && s.trim().length <= 254;

export function validateLogin(v: { email: string; password: string }): Errors<'email' | 'password'> {
  const e: Errors<'email' | 'password'> = {};
  if (!v.email.trim()) e.email = 'Enter your email address';
  else if (!isEmail(v.email)) e.email = 'Enter a valid email address';
  if (!v.password) e.password = 'Enter your password';
  return e;
}

export function validateRegister(v: { name: string; email: string; password: string; workspaceName?: string }): Errors<'name' | 'email' | 'password' | 'workspaceName'> {
  const e: Errors<'name' | 'email' | 'password' | 'workspaceName'> = {};
  if (!v.name.trim()) e.name = 'Enter your name';
  else if (v.name.trim().length > 100) e.name = 'Name must be at most 100 characters';
  if (!v.email.trim()) e.email = 'Enter your email address';
  else if (!isEmail(v.email)) e.email = 'Enter a valid email address';
  if (v.password.length < 8) e.password = 'Password must be at least 8 characters';
  else if (v.password.length > 200) e.password = 'Password must be at most 200 characters';
  if ((v.workspaceName ?? '').length > 100) e.workspaceName = 'Workspace name must be at most 100 characters';
  return e;
}
