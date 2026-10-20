import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OrderDispute } from '../api/types';
import { OrderStatusBadges } from './LeadsOrdersTabs';

const dispute = (over: Partial<OrderDispute> = {}): OrderDispute => ({ id: 'dsp_1', stripeDisputeId: 'dp_1', status: 'needs_response', outcome: 'open', reason: 'fraudulent', amountCents: 5000, currency: 'USD', evidenceDueBy: '2030-03-01T00:00:00.000Z', lostCents: 0, dashboardUrl: 'https://dashboard.stripe.com/test/disputes/dp_1', ...over });
const order = (status: Parameters<typeof OrderStatusBadges>[0]['order']['status'], d?: OrderDispute | null) => ({ status, refundedCents: 0, currency: 'USD', dispute: d });

describe('order status with disputes', () => {
  it('an open dispute shows a Disputed badge, the evidence due date and a link to the Stripe dashboard', () => {
    render(<OrderStatusBadges order={order('disputed', dispute())} />);
    expect(screen.getByText('Disputed')).toHaveClass('warn');
    const info = screen.getByTestId('dispute-info');
    expect(info).toHaveTextContent(/Dispute open, evidence due/);
    expect(info.querySelector('time')).toHaveAttribute('dateTime', '2030-03-01T00:00:00.000Z');
    const link = screen.getByRole('link', { name: 'View in Stripe' });
    expect(link).toHaveAttribute('href', 'https://dashboard.stripe.com/test/disputes/dp_1');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('a lost dispute shows Charged back and the amount deducted; a won one is back to Paid', () => {
    const { unmount } = render(<OrderStatusBadges order={order('charged_back', dispute({ outcome: 'lost', status: 'lost', lostCents: 5000 }))} />);
    expect(screen.getByText('Charged back')).toHaveClass('danger');
    expect(screen.getByTestId('dispute-info')).toHaveTextContent(/Dispute lost \(\$50\.00 deducted\)/);
    unmount();
    render(<OrderStatusBadges order={order('paid', dispute({ outcome: 'won', status: 'won' }))} />);
    expect(screen.getByText('Paid')).toHaveClass('ok');
    expect(screen.getByTestId('dispute-info')).toHaveTextContent('Dispute won');
  });

  it('an order without a dispute shows only its payment status', () => {
    render(<OrderStatusBadges order={order('refunded', null)} />);
    expect(screen.getByText('Refunded')).toBeInTheDocument();
    expect(screen.queryByTestId('dispute-info')).toBeNull();
  });
});
