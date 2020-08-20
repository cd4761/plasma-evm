const flatten = require('lodash/flatten');
const range = require('lodash/range');

const { createCurrency, createCurrencyRatio } = require('@makerdao/currency');
const {
  defaultSender, accounts, contract, web3,
} = require('@openzeppelin/test-environment');
const {
  BN, constants, expectEvent, expectRevert, time, ether,
} = require('@openzeppelin/test-helpers');

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
const { expect } = chai;
chai.use(require('chai-bn')(BN))
  .should();

const toChecksumAddress = web3.utils.toChecksumAddress;
const toBN = web3.utils.toBN;
const LOGTX = process.env.LOGTX || false;
const VERBOSE = process.env.VERBOSE || false;

const log = (...args) => LOGTX && console.log(...args);

let o;
process.on('exit', function () {
  console.log(o);
});
const development = true;

const _TON = createCurrency('TON');
const _WTON = createCurrency('WTON');
const _WTON_TON = createCurrencyRatio(_WTON, _TON);

const e = web3.utils.toBN('1000000000'); // 1e9

const TON_UNIT = 'wei';
const WTON_UNIT = 'ray';
const WTON_TON_RATIO = _WTON_TON('1');

const dummyStatesRoot = '0xdb431b544b2f5468e3f771d7843d9c5df3b4edcf8bc1c599f18f0b4ea8709bc3';
const dummyTransactionsRoot = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';
const dummyReceiptsRoot = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';

const TON_INITIAL_SUPPLY = _TON('10000');
const SEIG_PER_BLOCK = TON_INITIAL_SUPPLY.times(WTON_TON_RATIO).div(100); // 100 (W)TON / block
const WITHDRAWAL_DELAY = 10;
const NUM_ROOTCHAINS = 2;
const NUM_PLAYERS = 2;

const players = accounts.slice(0, NUM_PLAYERS);

const tokenAmount = TON_INITIAL_SUPPLY.div(100); // 100 TON

const NRE_LENGTH = 2;

const ROUND_DURATION = time.duration.minutes(1);

class RootChainState {
  constructor (NRE_LENGTH) {
    this.currentFork = 0;
    this.lastEpoch = 0;
    this.lastBlock = 0;
    this.NRE_LENGTH = Number(NRE_LENGTH);
  }
}

describe('stake/PowerTON', function () {
  function makePos (v1, v2) { return toBN(v1).shln(128).add(toBN(v2)); }

  async function checkBalanceProm (balanceProm, expected, unit) {
    return checkBalance(await balanceProm, expected, unit);
  }

  function checkBalance (balanceBN, expected, unit) {
    const v = balanceBN.sub(toBN(expected.toFixed(unit))).abs();
    v.should.be.bignumber.lte(e);
  }

  /**
   *
   * @param {*} rootchain
   * @param {RootChainState} rootchainState
   */
  async function submitDummyNRE (rootchain, rootchainState) {
    const pos1 = makePos(rootchainState.currentFork, rootchainState.lastEpoch + 1);
    const pos2 = makePos(rootchainState.lastBlock + 1, rootchainState.lastBlock + rootchainState.NRE_LENGTH);

    // console.log(`before commit RootChain#${rootchain.address}`, pos1, pos2, rootchainState);

    rootchainState.lastEpoch += 2; // skip ORE
    rootchainState.lastBlock += rootchainState.NRE_LENGTH;

    const COST_NRB = await rootchain.COST_NRB();

    return rootchain.submitNRE(
      pos1,
      pos2,
      dummyStatesRoot,
      dummyTransactionsRoot,
      dummyReceiptsRoot,
      { value: COST_NRB },
    );
  }

  function commits () {
    return Promise.all(this.rootchains.map(rootchain => this._commit(rootchain)));
  }

  function behaveRootChains () {
    it('operators should commit', async function () {
      await commits.call(this);
    });
  }

  function behavePowerTONStart () {
    it('should start PowerTON game', async function () {
      await this.powerton.start();
    });
  }

  function behaveRound (round = 0, maxRound = 2) {
    if (round === maxRound) return;
    const nextRound = round + 1;

    describe(`after round ${round} duration finished`, function () {
      beforeEach(async function () {
        await time.increase(ROUND_DURATION.add(toBN(1)));
        await commits.call(this);
      });

      behaveRootChains();

      it(`round ${round} should be end`, async function () {
        await this.powerton.endRound();
      });

      describe(`after round ${round} ends`, async function () {
        beforeEach(async function () {
          await this.powerton.endRound();
          this.balancesBeforeRoundEnd[nextRound] = await Promise.all(players.map(player => this.ton.balanceOf(player)));
        });

        it(`round ${nextRound} should be started`, async function () {
          expect(await this.powerton.currentRound()).to.be.bignumber.equal(String(nextRound));
        });

        it(`winner of round ${round} should receive TON`, async function () {
          const winner = await this.powerton.winnerOf(round);
          const winnerIndex = players.findIndex(p => p.toLowerCase() === winner.toLowerCase());

          expect(winnerIndex).to.be.gte(0);

          const reward = (await this.powerton.rounds(round)).reward;

          players.forEach((_, index) => {
            const expectedBalance = index === winnerIndex
              ? this.balancesBeforeRoundEnd[round][index].add(reward.div(toBN(1e9)))
              : this.balancesBeforeRoundEnd[round][index];

            expect(this.balancesBeforeRoundEnd[nextRound][index]).to.be.bignumber.equal(expectedBalance);
          });
        });

        if (nextRound <= maxRound) {
        // if (nextRound === maxRound) {
          it('players should receive (almost) equal amount of rewards', async function () {
            const winners = await Promise.all(range(nextRound).map((round) => this.powerton.winnerOf(round)));

            console.log('winners', winners);
            const f = (a) => (b) => a.toLowerCase() === b.toLowerCase();
            const winCounts = players.map(player => winners.filter(f(player)).length);

            const rewards = this.balancesBeforeRoundEnd[nextRound];
            rewards.forEach((reward, i) => {
              console.log(`${i}th player: winCount=${winCounts[i]} reward=${reward.toString(10)}`);
            });
          });
        }

        behaveRound(nextRound, maxRound);
      });
    });
  }

  // deploy contract and instances
  beforeEach(async function () {
    this.ton = await TON.new();
    this.wton = await WTON.new(this.ton.address);

    this.etherToken = await EtherToken.new(true, this.ton.address, true);

    const epochHandler = await EpochHandler.new();
    const submitHandler = await SubmitHandler.new(epochHandler.address);

    this.rootchains = await Promise.all(range(NUM_ROOTCHAINS).map(_ => RootChain.new(
      epochHandler.address,
      submitHandler.address,
      this.etherToken.address,
      development,
      NRE_LENGTH,
      dummyStatesRoot,
      dummyTransactionsRoot,
      dummyReceiptsRoot,
    )));

    // root chain state in local
    this.rootchainState = {};
    for (const rootchain of this.rootchains) {
      this.rootchainState[rootchain.address] = new RootChainState(NRE_LENGTH);
    }

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
      SEIG_PER_BLOCK.toFixed(WTON_UNIT),
    );

    this.powerton = await PowerTON.new(
      this.seigManager.address,
      this.wton.address,
      ROUND_DURATION,
    );

    await this.powerton.init();

    // add minter roles
    await this.wton.addMinter(this.seigManager.address);
    await this.ton.addMinter(this.wton.address);

    // set seig manager to contracts
    await Promise.all([
      this.depositManager,
      this.wton,
    ].map(contract => contract.setSeigManager(this.seigManager.address)));
    await Promise.all(this.rootchains.map(rootchain => rootchain.setSeigManager(this.seigManager.address)));

    // register root chain and deploy coinage
    await Promise.all(this.rootchains.map(rootchain => this.registry.registerAndDeployCoinage(rootchain.address, this.seigManager.address)));

    // mint TON to accounts
    await this.ton.mint(defaultSender, TON_INITIAL_SUPPLY.toFixed(TON_UNIT));
    await this.ton.approve(this.wton.address, TON_INITIAL_SUPPLY.toFixed(TON_UNIT));

    // swap TON to WTON and transfer to players
    await Promise.all(
      players.map(
        player =>
          this.wton.swapFromTONAndTransfer(player, tokenAmount.toFixed(TON_UNIT)),
      ),
    );

    // approve WTON to deposit manager
    await Promise.all(
      players.map(
        player =>
          this.wton.approve(this.depositManager.address, tokenAmount.toFixed(WTON_UNIT), { from: player }),
      ),
    );

    // load tot token and coinage tokens
    this.tot = await CustomIncrementCoinage.at(await this.seigManager.tot());
    const coinageAddrs = await Promise.all(
      this.rootchains.map(rootchain => this.seigManager.coinages(rootchain.address)),
    );

    this.coinages = [];
    this.coinagesByRootChain = {};
    for (const addr of coinageAddrs) {
      const i = coinageAddrs.findIndex(a => a === addr);
      this.coinages[i] = await CustomIncrementCoinage.at(addr);
      this.coinagesByRootChain[this.rootchains[i].address] = this.coinages[i];
    }

    // contract-call wrapper functions
    this._deposit = (from, to, amount) => this.depositManager.deposit(to, amount, { from });
    this._commit = (rootchain) => submitDummyNRE(rootchain, this.rootchainState[rootchain.address]);
  });

  describe('check compatibility', function () {
    describe('before setting PowerTON to SeigManager', function () {
      describe('before deposit TON', function () {
        behaveRootChains();
        behavePowerTONStart();
      });

      describe('after deposit TON', function () {
        beforeEach(async function () {
          await Promise.all(
            this.rootchains.map(
              rootchain => this._deposit(players[0], rootchain.address, tokenAmount.div(NUM_PLAYERS).toFixed(WTON_UNIT)),
            ),
          );
        });

        behaveRootChains();
        behavePowerTONStart();
      });
    });

    describe('after setting PowerTON to SeigManager', function () {
      beforeEach(async function () {
        await this.seigManager.setPowerTON(this.powerton.address);
      });

      describe('before deposit TON', function () {
        behaveRootChains();
        behavePowerTONStart();
      });

      describe('after deposit TON', function () {
        beforeEach(async function () {
          await Promise.all(
            this.rootchains.map(
              rootchain => this._deposit(players[0], rootchain.address, tokenAmount.div(NUM_PLAYERS).toFixed(WTON_UNIT)),
            ),
          );
        });

        behaveRootChains();
        behavePowerTONStart();
      });

      describe('after PowerTON game starts', function () {
        beforeEach(async function () {
          await this.powerton.start();
        });

        describe('before deposit TON', function () {
          behaveRootChains();
        });

        describe('after deposit TON', function () {
          beforeEach(async function () {
            await Promise.all(
              this.rootchains.map(
                rootchain => this._deposit(players[0], rootchain.address, tokenAmount.div(NUM_PLAYERS).toFixed(WTON_UNIT)),
              ),
            );
          });

          behaveRootChains();
        });
      });
    });
  });

  describe('after PowerTON started', function () {
    beforeEach(async function () {
      await this.seigManager.setPowerTON(this.powerton.address);
      await this.powerton.start();

      this.balancesBeforeRoundEnd = {};
    });

    describe('when players deposit equal amount of TON', function () {
      const amount = tokenAmount.div(NUM_ROOTCHAINS);

      beforeEach(async function () {
        this.receipts = await Promise.all(
          flatten(
            players.map(
              player =>
                this.rootchains.map(
                  rootchain => this._deposit(player, rootchain.address, amount.toFixed(WTON_UNIT)),
                ),
            ),
          ),
        );
        this.balancesBeforeRoundEnd[0] = await Promise.all(
          players.map(player => this.ton.balanceOf(player)),
        );
      });

      it('should emits PowerIncreased event', async function () {
        for (const receipt of this.receipts) {
          const from = toChecksumAddress(receipt.receipt.from);
          await expectEvent.inTransaction(receipt.tx, this.powerton, 'PowerIncreased', {
            account: from,
            amount: amount.toFixed(WTON_UNIT),
          });
        }
      });

      it('players should have same amount of Power as TON', async function () {
        await Promise.all(players.map(
          async (player) => {
            const power = await this.powerton.powerOf(player);
            expect(power).to.be.bignumber.eq(tokenAmount.toFixed(WTON_UNIT));
          },
        ));
      });

      behaveRootChains();

      behaveRound(0);
    });
  });
});
