package stamina

import (
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"math/big"
	"testing"

	"github.com/Onther-Tech/plasma-evm/accounts/abi/bind"
	"github.com/Onther-Tech/plasma-evm/accounts/abi/bind/backends"
	"github.com/Onther-Tech/plasma-evm/common"
	"github.com/Onther-Tech/plasma-evm/consensus/ethash"
	"github.com/Onther-Tech/plasma-evm/core"
	"github.com/Onther-Tech/plasma-evm/core/rawdb"
	"github.com/Onther-Tech/plasma-evm/core/types"
	"github.com/Onther-Tech/plasma-evm/core/vm"
	"github.com/Onther-Tech/plasma-evm/crypto"
	"github.com/Onther-Tech/plasma-evm/params"
)

var (
	delegateeKey, _ = crypto.HexToECDSA("49a7b37aa6f6645917e7b807e9d1c00d4fa71f18343b0d4122a4d2df64dd6fee")
	delegateeAddr   = crypto.PubkeyToAddress(delegateeKey.PublicKey)
	delegateeOpt    = bind.NewKeyedTransactor(delegateeKey)

	depositorAddr = delegateeAddr

	key1, _ = crypto.HexToECDSA("b71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291")
	key2, _ = crypto.HexToECDSA("8a1f9a8f95be41cd7ccb6168179afb4504aefe388d1e14474d32c45c72ce7b7a")
	addr1   = crypto.PubkeyToAddress(key1.PublicKey)
	addr2   = crypto.PubkeyToAddress(key2.PublicKey)
	opt1    = bind.NewKeyedTransactor(key1)
	opt2    = bind.NewKeyedTransactor(key2)
)

var (
	stamina             = big.NewInt(5000000000)
	minDeposit          = big.NewInt(100)
	recoveryEpochLength = big.NewInt(10)
	withdrawalDelay     = big.NewInt(50)
)

func TestStamina(t *testing.T) {
	staminaBinBytes, err := hex.DecodeString(params.StaminaContractDeployedBin[2:])
	if err != nil {
		panic(err)
	}

	contractBackend := backends.NewSimulatedBackend(core.GenesisAlloc{
		delegateeAddr: {Balance: big.NewInt(10000000000)},
		addr1:         {Balance: big.NewInt(0)},
		addr2:         {Balance: big.NewInt(10000000000)},
		params.StaminaAddress: {
			Code:    staminaBinBytes,
			Balance: big.NewInt(0),
		},
	}, 10000000000)

	staminaContract, err := NewStamina(delegateeOpt, params.StaminaAddress, contractBackend)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	// init
	if _, err := staminaContract.Init(minDeposit, recoveryEpochLength, withdrawalDelay); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	contractBackend.Commit()

	initialized, err := staminaContract.Initialized()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if !initialized {
		t.Errorf("expected: %v, got %v", false, initialized)
	}

	staminaContract.TransactOpts.Value = stamina
	// deposit
	if _, err := staminaContract.Deposit(delegateeAddr); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	contractBackend.Commit()

	deposit, err := staminaContract.GetDeposit(depositorAddr, delegateeAddr)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if deposit.Cmp(stamina) != 0 {
		t.Errorf("expected: %v, got %v", stamina, deposit)
	}

	// Eth    : short
	// Stamina: short
	if err := sendSignedTransferTransaction(contractBackend, addr1, key1); err == nil {
		t.Fatal("expected insufficient balance to pay for gas")
	}

	// Eth    : short
	// Stamina: enough
	staminaContract.TransactOpts = *delegateeOpt
	if _, err = staminaContract.SetDelegator(addr1); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	contractBackend.Commit()

	delegatee, err := staminaContract.GetDelegatee(addr1)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if delegatee != delegateeAddr {
		t.Errorf("expected: %v, got %v", delegateeAddr, delegatee)
	}

	staminaContract.TransactOpts = *opt1
	beforeStaminaRemaining, _ := staminaContract.GetStamina(delegateeAddr)
	beforeBalance, _ := contractBackend.BalanceAt(context.Background(), addr1, contractBackend.CurrentBlock())

	if err := sendSignedTransferTransaction(contractBackend, addr1, key1); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	contractBackend.Commit()

	afterStaminaRemaining, _ := staminaContract.GetStamina(delegateeAddr)
	afterBalance, _ := contractBackend.BalanceAt(context.Background(), addr1, contractBackend.CurrentBlock())

	if beforeBalance.Cmp(afterBalance) != 0 {
		t.Errorf("balance before: %v, after %v", beforeBalance, afterBalance)
	}
	if beforeStaminaRemaining.Cmp(new(big.Int).Add(afterStaminaRemaining, big.NewInt(21000))) != 0 {
		t.Error("failed precise stamina subtract")
	}

	// Eth    : enough
	// Stamina: short
	staminaContract.TransactOpts = *opt2
	beforeStaminaRemaining, _ = staminaContract.GetStamina(delegateeAddr)
	beforeBalance, _ = contractBackend.BalanceAt(context.Background(), addr2, contractBackend.CurrentBlock())

	if err := sendSignedTransferTransaction(contractBackend, addr2, key2); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	contractBackend.Commit()

	afterStaminaRemaining, _ = staminaContract.GetStamina(delegateeAddr)
	afterBalance, _ = contractBackend.BalanceAt(context.Background(), addr2, contractBackend.CurrentBlock())

	if beforeBalance.Cmp(new(big.Int).Add(afterBalance, big.NewInt(21000))) != 0 {
		t.Error("failed precise balance subtract")
	}
	if beforeStaminaRemaining.Cmp(afterStaminaRemaining) != 0 {
		t.Errorf("stamina before: %v, after %v", beforeStaminaRemaining, afterStaminaRemaining)
	}

	// Eth    : enough
	// Stamina: enough
	staminaContract.TransactOpts = *delegateeOpt
	if _, err := staminaContract.SetDelegator(addr2); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	contractBackend.Commit()

	delegatee, err = staminaContract.GetDelegatee(addr2)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if delegatee != delegateeAddr {
		t.Errorf("expected: %v, got %v", delegateeAddr, delegatee)
	}

	staminaContract.TransactOpts = *opt2
	beforeStaminaRemaining, _ = staminaContract.GetStamina(delegateeAddr)
	beforeBalance, _ = contractBackend.BalanceAt(context.Background(), addr2, contractBackend.CurrentBlock())

	if err := sendSignedTransferTransaction(contractBackend, addr2, key2); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	contractBackend.Commit()

	afterStaminaRemaining, _ = staminaContract.GetStamina(delegateeAddr)
	afterBalance, _ = contractBackend.BalanceAt(context.Background(), addr2, contractBackend.CurrentBlock())

	if beforeBalance.Cmp(afterBalance) != 0 {
		t.Errorf("balance before: %v, after %v", beforeBalance, afterBalance)
	}
	if beforeStaminaRemaining.Cmp(new(big.Int).Add(afterStaminaRemaining, big.NewInt(21000))) != 0 {
		t.Error("failed precise stamina subtract")
	}
}

func TestGetDefaultStaminaFromStorageKey(t *testing.T) {
	var (
		defaultStaminaConfig = params.DefaultStaminaConfig
		operator             = common.HexToAddress("0x71562b71999873DB5b286dF957af199Ec94617F7")
	)

	gspec := core.DefaultGenesisBlock(common.Address{}, operator, defaultStaminaConfig)
	db := rawdb.NewMemoryDatabase()
	gspec.MustCommit(db)
	blockchain, _ := core.NewBlockChain(db, nil, params.MainnetChainConfig, ethash.NewFaker(), vm.Config{EnablePreimageRecording: true}, nil)

	statedb, _ := blockchain.State()
	stamina := statedb.GetState(params.StaminaAddress, params.GetStaminaKey(operator))
	if common.BytesToHash(params.DefaultOperatorStamina.Bytes()) != common.BytesToHash(stamina.Bytes()) {
		t.Fatalf("unexpected value: want %x, got %x", params.DefaultOperatorStamina, stamina)
	}
}

func TestStaminaGenesisConfig(t *testing.T) {
	defaultStaminaConfig := params.DefaultStaminaConfig
	g := core.DefaultGenesisBlock(common.Address{}, common.Address{1}, defaultStaminaConfig)
	gNumber := big.NewInt(0)
	ctx := context.Background()
	contractBackend := backends.NewSimulatedBackend(g.Alloc, 10000000000)

	initialized, err := contractBackend.StorageAt(ctx, params.StaminaAddress, params.StaminaInitializedKey, gNumber)
	if !common.ByteToBool(initialized[31]) {
		t.Errorf("unexpected value: want %t, got %t", true, common.ByteToBool(initialized[31]))
	}
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	minDeposit, err := contractBackend.StorageAt(ctx, params.StaminaAddress, params.StaminaMinDepositKey, gNumber)
	if common.BytesToHash(minDeposit) != common.BytesToHash(defaultStaminaConfig.MinDeposit.Bytes()) {
		t.Errorf("unexpected value: want %x, got %x", common.ToHex(defaultStaminaConfig.MinDeposit.Bytes()), common.ToHex(minDeposit))
	}
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	recoverEpochLength, err := contractBackend.StorageAt(ctx, params.StaminaAddress, params.StaminaRecoverEpochLengthKey, gNumber)
	if common.BytesToHash(recoverEpochLength) != common.BytesToHash(defaultStaminaConfig.RecoverEpochLength.Bytes()) {
		t.Errorf("unexpected value: want %x, got %x", common.ToHex(defaultStaminaConfig.RecoverEpochLength.Bytes()), common.ToHex(recoverEpochLength))
	}
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	withdrawalDelay, err := contractBackend.StorageAt(ctx, params.StaminaAddress, params.StaminaWithdrawalDelayKey, gNumber)
	if common.BytesToHash(withdrawalDelay) != common.BytesToHash(defaultStaminaConfig.WithdrawalDelay.Bytes()) {
		t.Errorf("unexpected value: want %x, got %x", common.ToHex(defaultStaminaConfig.WithdrawalDelay.Bytes()), common.ToHex(withdrawalDelay))
	}
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func sendSignedTransferTransaction(contractBackend *backends.SimulatedBackend, addr common.Address, key *ecdsa.PrivateKey) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = r.(error)
		}
	}()

	nonce, err := contractBackend.NonceAt(context.Background(), addr, contractBackend.CurrentBlock())
	if err != nil {
		return err
	}
	signedTx, err := types.SignTx(types.NewTransaction(nonce, common.Address{}, big.NewInt(0), params.TxGas, big.NewInt(1), nil), types.HomesteadSigner{}, key)
	if err != nil {
		return err
	}
	err = contractBackend.SendTransaction(context.Background(), signedTx)
	if err != nil {
		return err
	}

	return nil
}
