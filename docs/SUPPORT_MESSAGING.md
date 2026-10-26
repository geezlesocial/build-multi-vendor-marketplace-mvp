# Support and messaging

## Implemented workflow

- A signed-in member can open a ticket with a subject, category, first message, and optionally one of their own seller-order records.
- Order-linked tickets are visible to that order's seller workspace and platform administrators. General tickets are visible to the buyer and administrators only.
- Buyers, the assigned seller, and administrators can read and reply to the same participant-visible thread. No private staff notes are supported, so the UI does not imply that any reply is private from the buyer.
- Administrators can filter by status, assign a ticket to themselves, set priority, and move tickets through open, in-progress, waiting, resolved, and closed states. Closed tickets are terminal. A buyer can reopen a resolved ticket by replying within seven days.
- Ticket creation, replies, and administrative changes are written to the audit log. In-app notifications are sent to relevant participants and administrators. The UI refreshes ticket lists and selected threads every ten seconds while the page is visible.

## Access and data safeguards

- Ticket access is checked server-side for every read, reply, and status change. A seller can see only tickets linked to one of that seller's orders; knowing a ticket ID is not sufficient to read it.
- Linking an order requires the authenticated buyer to own the order's seller-order record.
- Buyer replies cannot modify priority, assignment, or ticket status directly. Only platform administrators can perform those queue actions.
- Ticket message bodies are bounded to 4,000 characters and are rendered as plain text.
- Creating or replying to support tickets does not change an order, issue a refund, release a payout, or override the separate Order & Financial Resolution workflow.

## Current boundaries

This is an in-app support inbox, not a staffed helpdesk service. Email/SMS, SLA policies, automatic escalation, attachment scanning, private internal notes, message editing/deletion, and external CRM integrations are not implemented. Existing buyer-seller product conversations remain separate from support tickets. Real-time updates currently use ten-second polling rather than a websocket or push transport.
