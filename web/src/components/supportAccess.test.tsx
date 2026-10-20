import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SupportBanner, SupportSessionDialog, WRITE_REASON_MIN } from './SupportAccess';

describe('support access banner', () => {
  it('read-only is the default notice and says nothing can be changed', () => {
    const onEnd = vi.fn();
    render(<SupportBanner imp={{ by: 'ops@platform.test', expiresAt: null, readOnly: true, allowWrites: false }} email="cora@example.test" onEnd={onEnd} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('data-support-mode', 'read_only');
    expect(banner).toHaveTextContent('Support access (read-only)');
    expect(banner).toHaveTextContent('nothing can be changed');
    expect(banner).not.toHaveClass('error');
    fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect(onEnd).toHaveBeenCalled();
  });

  it('a write-enabled session is a prominent red alert that says changes are recorded', () => {
    render(<SupportBanner imp={{ by: 'ops@platform.test', expiresAt: '2030-01-01T10:00:00.000Z', readOnly: false, allowWrites: true }} email="cora@example.test" onEnd={() => undefined} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('data-support-mode', 'read_write');
    expect(banner).toHaveClass('error');
    expect(banner).toHaveTextContent('Support access with WRITE permission');
    expect(banner).toHaveTextContent('audit log');
    expect(banner).toHaveTextContent('Ends');
  });
});

describe('support session dialog', () => {
  const open = (canWrite: boolean) => {
    const onSubmit = vi.fn();
    render(<SupportSessionDialog canWrite={canWrite} busy={false} error={null} onClose={() => undefined} onSubmit={onSubmit} />);
    return onSubmit;
  };

  it('opens read-only with a 5 character reason; the writes option is disabled for a support administrator', () => {
    const onSubmit = open(false);
    expect(screen.getByLabelText(/Allow changes/)).toBeDisabled();
    expect(screen.getByText(/Only a superadmin/)).toBeInTheDocument();
    const start = screen.getByRole('button', { name: 'Start support session' });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'ticket' } });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(onSubmit).toHaveBeenCalledWith('ticket', false);
  });

  it('a superadmin who opts into writes needs a longer reason', () => {
    const onSubmit = open(true);
    fireEvent.click(screen.getByLabelText(/Allow changes/));
    const start = screen.getByRole('button', { name: 'Start support session' });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'short but valid' } });
    expect(start).toBeDisabled();
    const reason = 'x'.repeat(WRITE_REASON_MIN);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: reason } });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(onSubmit).toHaveBeenCalledWith(reason, true);
  });
});
