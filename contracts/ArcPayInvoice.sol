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
        uint256 indexed id,
        address indexed merchant,
        uint256 amount,
        string note
    );

    event InvoicePaid(
        uint256 indexed id,
        address indexed payer,
        address indexed merchant,
        uint256 amount,
        string note,
        string memo
    );

    constructor(address usdcAddress) {
        usdc = IERC20(usdcAddress);
    }

    function createInvoice(
        address merchant,
        uint256 amount,
        string memory note
    ) public {
        require(merchant != address(0), "Invalid merchant");
        require(amount > 0, "Invalid amount");

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

        require(invoice.merchant != address(0), "Invoice not found");
        require(!invoice.paid, "Already paid");

        bool ok = usdc.transferFrom(
            msg.sender,
            invoice.merchant,
            invoice.amount
        );

        require(ok, "USDC transfer failed");

        invoice.payer = msg.sender;
        invoice.paid = true;

        string memory memo = string(
            abi.encodePacked("ArcPay invoice payment: ", invoice.note)
        );

        emit InvoicePaid(
            invoiceId,
            msg.sender,
            invoice.merchant,
            invoice.amount,
            invoice.note,
            memo
        );
    }
}