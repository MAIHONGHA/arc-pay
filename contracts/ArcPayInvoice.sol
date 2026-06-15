// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}

contract ArcPayInvoice {
    IERC20 public usdc;

    struct Invoice {
        uint256 id;
        address payer;
        address merchant;
        uint256 amount;
        bool paid;
        string note;
    }

    uint256 public nextInvoiceId;

    mapping(uint256 => Invoice) public invoices;

    event InvoiceCreated(
        uint256 id,
        address merchant,
        uint256 amount,
        string note
    );

    event InvoicePaid(
        uint256 id,
        address payer,
        address merchant,
        uint256 amount
    );

    constructor(address usdcAddress) {
        usdc = IERC20(usdcAddress);
    }

    function createInvoice(
        address merchant,
        uint256 amount,
        string memory note
    ) public {
        invoices[nextInvoiceId] = Invoice({
            id: nextInvoiceId,
            payer: address(0),
            merchant: merchant,
            amount: amount,
            paid: false,
            note: note
        });

        emit InvoiceCreated(
            nextInvoiceId,
            merchant,
            amount,
            note
        );

        nextInvoiceId++;
    }

    function payInvoice(uint256 invoiceId) public {
        Invoice storage invoice = invoices[invoiceId];

        require(!invoice.paid, "Already paid");
        require(invoice.merchant != address(0), "Invoice not found");

        bool ok = usdc.transferFrom(
            msg.sender,
            invoice.merchant,
            invoice.amount
        );

        require(ok, "USDC transfer failed");

        invoice.payer = msg.sender;
        invoice.paid = true;

        emit InvoicePaid(
            invoiceId,
            msg.sender,
            invoice.merchant,
            invoice.amount
        );
    }
}