CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "ticketNumber" VARCHAR(40) NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT,
    "parentOrderId" TEXT,
    "sellerOrderId" TEXT,
    "subject" VARCHAR(140) NOT NULL,
    "category" VARCHAR(24) NOT NULL DEFAULT 'OTHER',
    "status" VARCHAR(24) NOT NULL DEFAULT 'OPEN',
    "priority" VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
    "assignedAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupportTicket_category_check" CHECK ("category" IN ('ORDER', 'DELIVERY', 'PAYMENT', 'PRODUCT', 'ACCOUNT', 'OTHER')),
    CONSTRAINT "SupportTicket_status_check" CHECK ("status" IN ('OPEN', 'IN_PROGRESS', 'WAITING_ON_BUYER', 'WAITING_ON_SELLER', 'RESOLVED', 'CLOSED')),
    CONSTRAINT "SupportTicket_priority_check" CHECK ("priority" IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
    CONSTRAINT "SupportTicket_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SupportTicket_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SupportTicket_parentOrderId_fkey" FOREIGN KEY ("parentOrderId") REFERENCES "ParentOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SupportTicket_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SupportTicket_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SupportTicket_ticketNumber_key" ON "SupportTicket"("ticketNumber");
CREATE INDEX "SupportTicket_buyerId_updatedAt_idx" ON "SupportTicket"("buyerId", "updatedAt");
CREATE INDEX "SupportTicket_sellerId_status_updatedAt_idx" ON "SupportTicket"("sellerId", "status", "updatedAt");
CREATE INDEX "SupportTicket_status_priority_updatedAt_idx" ON "SupportTicket"("status", "priority", "updatedAt");
CREATE INDEX "SupportTicket_parentOrderId_idx" ON "SupportTicket"("parentOrderId");

CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorRole" VARCHAR(20) NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupportMessage_authorRole_check" CHECK ("authorRole" IN ('BUYER', 'SELLER', 'CASHIER', 'ADMIN', 'CONTENT_EDITOR')),
    CONSTRAINT "SupportMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SupportMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "SupportMessage_ticketId_createdAt_idx" ON "SupportMessage"("ticketId", "createdAt");
