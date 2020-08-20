const { range, last, first } = require('lodash');

const { createCurrency, createCurrencyRatio } = require('@makerdao/currency');
const {
  defaultSender, accounts, contract, web3,
} = require('@openzeppelin/test-environment');
const {
  BN, constants, expectEvent, expectRevert, time, ether,
} = require('@openzeppelin/test-helpers');

const { padLeft, toBN } = require('web3-utils');

const { marshalString, unmarshalString } = require('../helpers/marshal');

const WTON = contract.fromArtifact('WTON');
const TON = contract.fromArtifact('TON');

const EpochHandler = contract.fromArtifact('EpochHandler');
const SubmitHandler = contract.fromArtifact('SubmitHandler');
const RootChain = contract.fromArtifact('RootChain');
const EtherToken = contract.fromArtifact('EtherToken');

const DepositManager = contract.fromArtifact('DepositManager');
const SeigManager = contract.fromArtifact('SeigManager');
const RootChainRegistry = contract.fromArtifact('RootChainRegistry');
const CustomIncrementCoinage = contract.fromArtifact('CustomIncrementCoinage');
const PowerTON = contract.fromArtifact('PowerTON');

const chai = require('chai');
chai
  .use(require('chai-bn')(BN))
  .should();
const { expect } = chai;

const LOGTX = process.env.LOGTX || false;
const VERBOSE = process.env.VERBOSE || false;

const development = true;

const _TON = createCurrency('TON');
const _WTON = createCurrency('WTON');

const TON_UNIT = 'wei';
const WTON_UNIT = 'ray';

const [operator, tokenOwner] = accounts;

const dummyStatesRoot = '0xdb431b544b2f5468e3f771d7843d9c5df3b4edcf8bc1c599f18f0b4ea8709bc3';
const dummyTransactionsRoot = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const dummyReceiptsRoot = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';

const initialSupply = _WTON('1000');
const tokenAmount = initialSupply.div(100);
const WITHDRAWAL_DELAY = 10;

const ROUND_DURATION = time.duration.minutes(1);

describe('stake/DepositManager', function () {
  beforeEach(async function () {
    this.ton = await TON.new();
    this.wton = await WTON.new(this.ton.address);

    this.etherToken = await EtherToken.new(true, this.ton.address, true);

    const epochHandler = await EpochHandler.new();
    const submitHandler = await SubmitHandler.new(epochHandler.address);

    this.rootchain = await RootChain.new(
      epochHandler.address,
      submitHandler.address,
      this.etherToken.address,
      development,
      1,
      dummyStatesRoot,
      dummyTransactionsRoot,
      dummyReceiptsRoot,
    );

    this.registry = await RootChainRegistry.new();

    this.depositManager = await DepositManager.new(
      this.wton.address,
      this.registry.address,
      WITHDRAWAL_DELAY,
    );

    this.seigManager = await SeigManager.new(
      this.ton.address,
      this.wton.address,
      this.registry.address,
      this.depositManager.address,
      _WTON('100').toFixed(WTON_UNIT),
    );

    this.powerton = await PowerTON.new(
      this.seigManager.address,
      this.wton.address,
      ROUND_DURATION,
    );

    await this.powerton.init();

    await this.seigManager.setPowerTON(this.powerton.address);
    await this.powerton.start();

    // add minter roles
    await this.wton.addMinter(this.seigManager.address);
    await this.ton.addMinter(this.wton.address);

    // set seig manager to contracts
    await Promise.all([
      this.depositManager,
      this.wton,
    ].map(contract => contract.setSeigManager(this.seigManager.address)));
    await this.rootchain.setSeigManager(this.seigManager.address);

    // register root chain and deploy coinage
    await this.registry.registerAndDeployCoinage(this.rootchain.address, this.seigManager.address);

    // mint WTON to account
    await this.wton.mint(tokenOwner, initialSupply.toFixed(WTON_UNIT));

    // load coinage and tot
    this.coinage = await CustomIncrementCoinage.at(await this.seigManager.coinages(this.rootchain.address));
    this.tot = await CustomIncrementCoinage.at(await this.seigManager.tot());
  });

  describe('when the token owner tries to deposit', function () {
    describe('after the token holder approve WTON', function () {
      beforeEach(async function () {
        await this.wton.approve(this.depositManager.address, tokenAmount.toFixed(WTON_UNIT), { from: tokenOwner });
      });

      it('should deposit WTON', async function () {
        const wtonBalance0 = await this.wton.balanceOf(tokenOwner);

        const { tx } = await this.depositManager.deposit(this.rootchain.address, tokenAmount.toFixed(WTON_UNIT), { from: tokenOwner });
        const wtonBalance1 = await this.wton.balanceOf(tokenOwner);

        await expectEvent.inTransaction(tx, this.wton, 'Transfer', {
          from: tokenOwner,
          to: this.depositManager.address,
          value: tokenAmount.toFixed(WTON_UNIT),
        });

        await expectEvent.inTransaction(tx, this.depositManager, 'Deposited', {
          rootchain: this.rootchain.address,
          depositor: tokenOwner,
          amount: tokenAmount.toFixed(WTON_UNIT),
        });

        expect(await this.seigManager.stakeOf(this.rootchain.address, tokenOwner)).to.be.bignumber.equal(tokenAmount.toFixed(WTON_UNIT));
        expect(wtonBalance0.sub(wtonBalance1)).to.be.bignumber.equal(tokenAmount.toFixed(WTON_UNIT));
      });
    });

    describe('when the token owner tries to deposit with TON.approveAndCall', async function () {
      beforeEach(async function () {
        await this.ton.mint(tokenOwner, tokenAmount.toFixed(TON_UNIT));
      });

      it('should deposit WTON from TON', async function () {
        const tonBalance0 = await this.ton.balanceOf(tokenOwner);

        const data = marshalString(
          [this.depositManager.address, this.rootchain.address]
            .map(unmarshalString)
            .map(str => padLeft(str, 64))
            .join(''),
        );

        const { tx } = await this.ton.approveAndCall(
          this.wton.address,
          tokenAmount.toFixed(TON_UNIT),
          data,
          { from: tokenOwner },
        );
        const tonBalance1 = await this.ton.balanceOf(tokenOwner);

        await expectEvent.inTransaction(tx, this.wton, 'Transfer', {
          from: tokenOwner,
          to: this.depositManager.address,
          value: tokenAmount.toFixed(WTON_UNIT),
        });

        await expectEvent.inTransaction(tx, this.depositManager, 'Deposited', {
          rootchain: this.rootchain.address,
          depositor: tokenOwner,
          amount: tokenAmount.toFixed(WTON_UNIT),
        });

        expect(await this.seigManager.stakeOf(this.rootchain.address, tokenOwner)).to.be.bignumber.equal(tokenAmount.toFixed(WTON_UNIT));
        expect(tonBalance0.sub(tonBalance1)).to.be.bignumber.equal(tokenAmount.toFixed(TON_UNIT));
      });
    });
  });

  describe('after the token owner deposits tokens', function () {
    beforeEach(async function () {
      await this.wton.approve(this.depositManager.address, tokenAmount.toFixed(WTON_UNIT), { from: tokenOwner });
      await this.depositManager.deposit(this.rootchain.address, tokenAmount.toFixed(WTON_UNIT), { from: tokenOwner });
    });

    describe('when the token owner tries to withdraw', function () {
      it('should make a withdrawal request', async function () {
        await this.depositManager.requestWithdrawal(this.rootchain.address, tokenAmount.toFixed(WTON_UNIT), { from: tokenOwner });
      });

      it('should get request data', async function () {
        const n = 10;
        for (const index of range(n)) {
          await this.depositManager.requestWithdrawal(this.rootchain.address, tokenAmount.div(n).toFixed(WTON_UNIT), { from: tokenOwner });

          const request = await this.depositManager.withdrawalRequest(this.rootchain.address, tokenOwner, index);
          expect(request.amount).to.be.bignumber.equal(tokenAmount.div(n).toFixed(WTON_UNIT));

          expect(await this.depositManager.numRequests(this.rootchain.address, tokenOwner))
            .to.be.bignumber.equal(toBN(index + 1));
          expect(await this.depositManager.numPendingRequests(this.rootchain.address, tokenOwner))
            .to.be.bignumber.equal(toBN(index + 1));
        }
      });

      describe('before WITHDRAWAL_DELAY blocks are mined', function () {
        beforeEach(async function () {
          await this.depositManager.requestWithdrawal(this.rootchain.address, tokenAmount.toFixed(WTON_UNIT), { from: tokenOwner });
        });

        it('should not process withdrawal request', async function () {
          await expectRevert(
            this.depositManager.processRequest(this.rootchain.address, false, { from: tokenOwner }),
            'DepositManager: wait for withdrawal delay',
          );
        });

        it('should be able to re-deposit pending request', async function () {
          await this.depositManager.redeposit(this.rootchain.address, { from: tokenOwner });
        });
      });

      describe('after WITHDRAWAL_DELAY blocks are mined', function () {
        beforeEach(async function () {
          await this.depositManager.requestWithdrawal(this.rootchain.address, tokenAmount.toFixed(WTON_UNIT), { from: tokenOwner });
          await Promise.all(range(WITHDRAWAL_DELAY + 1).map(_ => time.advanceBlock()));
        });

        it('should withdraw deposited WTON to the token owner', async function () {
          const { tx } = await this.depositManager.processRequest(this.rootchain.address, false, { from: tokenOwner });

          await expectEvent.inTransaction(tx, this.wton, 'Transfer', {
            from: this.depositManager.address,
            to: tokenOwner,
            value: tokenAmount.toFixed(WTON_UNIT),
          });
        });

        it('should withdraw deposited WTON to the token owner in TON', async function () {
          const { tx } = await this.depositManager.processRequest(this.rootchain.address, true, { from: tokenOwner });

          await expectEvent.inTransaction(tx, this.ton, 'Transfer', {
            from: this.wton.address,
            to: tokenOwner,
            value: tokenAmount.toFixed(TON_UNIT),
          });
        });

        it('should be able to re-deposit pending request', async function () {
          await this.depositManager.redeposit(this.rootchain.address, { from: tokenOwner });
        });
      });

      describe('when the token owner make 2 requests', function () {
        const amount = tokenAmount.div(2);
        const n = 2;

        beforeEach(async function () {
          await Promise.all(range(n).map(_ =>
            this.depositManager.requestWithdrawal(this.rootchain.address, amount.toFixed(WTON_UNIT), { from: tokenOwner }),
          ));
        });

        describe('before WITHDRAWAL_DELAY blocks are mined', function () {
          it('should not process withdrawal request', async function () {
            await expectRevert(
              this.depositManager.processRequest(this.rootchain.address, false, { from: tokenOwner }),
              'DepositManager: wait for withdrawal delay',
            );
          });

          it('should be able to re-deposit all pending request', async function () {
            await Promise.all(range(n).map(
              _ => this.depositManager.redeposit(this.rootchain.address, { from: tokenOwner }),
            ));
            // await this.depositManager.redeposit(this.rootchain.address, { from: tokenOwner });
            // await this.depositManager.redeposit(this.rootchain.address, { from: tokenOwner });
          });

          it('should be able to re-deposit all pending request in a single transaction', async function () {
            await this.depositManager.redepositMulti(this.rootchain.address, 2, { from: tokenOwner });
          });
        });

        describe('after WITHDRAWAL_DELAY blocks are mined', function () {
          beforeEach(async function () {
            await Promise.all(range(WITHDRAWAL_DELAY + 1).map(_ => time.advanceBlock()));
          });

          it('should process 2 requests', async function () {
            for (const _ of range(2)) {
              const { tx } = await this.depositManager.processRequest(this.rootchain.address, false, { from: tokenOwner });

              await expectEvent.inTransaction(tx, this.wton, 'Transfer', {
                from: this.depositManager.address,
                to: tokenOwner,
                value: amount.toFixed(WTON_UNIT),
              });
            }
          });

          it('should be able to re-deposit all pending request', async function () {
            await Promise.all(range(n).map(
              _ => this.depositManager.redeposit(this.rootchain.address, { from: tokenOwner }),
            ));
          });

          it('should be able to re-deposit all pending request in a single transaction', async function () {
            await this.depositManager.redepositMulti(this.rootchain.address, 2, { from: tokenOwner });
          });
        });
      });
    });
  });
});
