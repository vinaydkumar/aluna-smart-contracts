const { TestHelper } = require('@openzeppelin/cli')
const { BN, constants, expectEvent, expectRevert, time } = require('openzeppelin-test-helpers');
const { ZERO_ADDRESS } = constants;
const { Contracts, ZWeb3 } = require('@openzeppelin/upgrades')

const should = require('chai').should();
const { expect } = require('chai');

ZWeb3.initialize(web3.currentProvider);
Contracts.setArtifactsDefaults({
  gas: 60000000,
});

const AlunaToken = Contracts.getFromLocal('AlunaToken');
const TokenVesting = Contracts.getFromLocal('TokenVesting');

contract('TokenVesting', function ([_, proxyOwner, alunaOrg, beneficiary]) {

  const amount = new BN('1000');

  beforeEach(async function () {

    // +1 minute so it starts after contract instantiation
    this.start = (await time.latest()).add(time.duration.minutes(1));
    this.cliffDuration = time.duration.years(1);
    this.duration = time.duration.years(2);

    this.project = await TestHelper()

    this.token = await this.project.createProxy(AlunaToken, {
      from: alunaOrg,
      initFunction: 'initialize',
      initArgs: [amount.toString(), _, 10, alunaOrg],
    });

    this.vesting = await this.project.createProxy(TokenVesting)
  });

  it('vesting contract should have 1000 ALN', async function () {
    await this.token.methods
      .transfer(this.vesting.address, 1000)
      .send({ from: alunaOrg });
    
    const balance = await this.token.methods
      .balanceOf(this.vesting.address)
      .call()
    
    balance.should.be.equal('1000');
  });

  it('reverts with a duration shorter than the cliff', async function () {
    const cliffDuration = this.duration;
    const duration = this.cliffDuration;

    expect(cliffDuration).to.be.bignumber.that.is.at.least(duration);

    const methodCall = this.vesting.methods
      .initialize(
        beneficiary, 
        this.start.toString(), 
        cliffDuration.toString(), 
        duration.toString(), 
        true,
        alunaOrg
      ).send({ from: alunaOrg })

    await expectRevert(
      methodCall,
      'TokenVesting: cliff is longer than duration'
    );
  });

  it('reverts with a null beneficiary', async function () {
    const methodCall = this.vesting.methods
      .initialize(
        ZERO_ADDRESS, 
        this.start.toString(),
        this.cliffDuration.toString(),
        this.duration.toString(),
        true,
        alunaOrg
      ).send({ from: alunaOrg })

    await expectRevert(
      methodCall,
      'TokenVesting: beneficiary is the zero address'
    );
  });

  it('reverts with a null duration', async function () {
    const methodCall = this.vesting.methods
      .initialize(
        beneficiary, 
        this.start.toString(), 
        0, 
        0, 
        true,
        alunaOrg
      ).send({ from: alunaOrg })

    // cliffDuration should also be 0, since the duration must be larger than the cliff
    await expectRevert(
      methodCall,
      'TokenVesting: duration is 0'
    );
  });

  it('reverts if the end time is in the past', async function () {
    const now = await time.latest();

    this.start = now.sub(this.duration).sub(time.duration.minutes(1));

    const methodCall = this.vesting.methods
      .initialize(
        beneficiary, 
        this.start.toString(), 
        this.cliffDuration.toString(), 
        this.duration.toString(), 
        true,
        alunaOrg
      ).send({ from: alunaOrg })

    await expectRevert(
      methodCall,
      'TokenVesting: final time is before current time'
    );
  });


  context('once deployed', function () {
    beforeEach(async function () {

      await this.vesting.methods
        .initialize(
          beneficiary, 
          this.start.toString(), 
          this.cliffDuration.toString(), 
          this.duration.toString(), 
          true,
          alunaOrg
        ).send({ from: alunaOrg })

      await this.token.methods
        .transfer(
          this.vesting.address, 
          amount.toString()
        )
        .send({ from: alunaOrg });
    });

    it('can get state', async function () {
      expect(await this.vesting.methods.beneficiary().call())
        .to.equal(beneficiary);
      
      expect(await this.vesting.methods.cliff().call())
        .to.be.bignumber.equal(this.start.add(this.cliffDuration));

      expect(await this.vesting.methods.start().call())
        .to.be.bignumber.equal(this.start);

      expect(await this.vesting.methods.duration().call())
        .to.be.bignumber.equal(this.duration);

      expect(await this.vesting.methods.revocable().call())
        .to.be.equal(true);
    });

    it('cannot be released before cliff', async function () {
      const methodCall = this.vesting.methods
        .release(this.token.address)
        .call()

      await expectRevert(
        methodCall,
        'TokenVesting: no tokens are due'
      );
    });

    it('can be released after cliff', async function () {
      await time.increaseTo(
        this.start.add(this.cliffDuration).add(time.duration.years(2))
      );

      const releaseable = await this.vesting.methods
        .releasable(this.token.address)
        .call({from: alunaOrg})

      const result = await this.vesting.methods
        .release(this.token.address)
        .send({from: alunaOrg})

      const expectedBalance = await this.token.methods
        .balanceOf(beneficiary)
        .call()

      const tokensReleased = result.events.TokensReleased.returnValues

      expect(tokensReleased.token).to.be.equal(this.token.address)
      expect(tokensReleased.amount).to.be.equal(expectedBalance)
      expect(tokensReleased.amount).to.be.equal(releaseable)
    });

    it('should release proper amount after cliff', async function () {
      await time.increaseTo(this.start.add(this.cliffDuration))

      await this.vesting.methods.release(this.token.address).send()

      const releaseTime = await time.latest()

      const releasedAmount = amount
        .mul(releaseTime.sub(this.start))
        .div(this.duration)

      expect(await this.token.methods.balanceOf(beneficiary).call())
        .to.be.bignumber.equal(releasedAmount)
      
      expect(await this.vesting.methods.released(this.token.address).call())
        .to.be.bignumber.equal(releasedAmount)
    });

    it('should linearly release tokens during vesting period', async function () {
      const vestingPeriod = this.duration.sub(this.cliffDuration);
      const checkpoints = 4;

      for (let i = 1; i <= checkpoints; i++) {
        const now = this.start
          .add(this.cliffDuration)
          .add((vestingPeriod.muln(i).divn(checkpoints)))
        
        await time.increaseTo(now);

        await this.vesting.methods.release(this.token.address).send()

        const expectedVesting = amount
          .mul(now.sub(this.start))
          .div(this.duration)
        
        expect(await this.token.methods.balanceOf(beneficiary).call())
          .to.be.bignumber.equal(expectedVesting)

        expect(await this.vesting.methods.released(this.token.address).call())
          .to.be.bignumber.equal(expectedVesting)
      }
    });

    it('should have released all after end', async function () {
      await time.increaseTo(this.start.add(this.duration));
      await this.vesting.methods.release(this.token.address).send()

      expect(await this.token.methods.balanceOf(beneficiary).call())
        .to.be.bignumber.equal(amount);

      expect(await this.vesting.methods.released(this.token.address).call())
        .to.be.bignumber.equal(amount);
    });

    it('should be revoked by owner if revocable is set', async function () {
      const owner = await this.vesting.methods.owner().call()

      const result = await this.vesting.methods
        .revoke(this.token.address)
        .send({from: alunaOrg})

      const TokenVestingRevoked = result.events.TokenVestingRevoked.returnValues

      expect(TokenVestingRevoked.token).to.be.equal(this.token.address)

      expect(await this.vesting.methods.revoked(this.token.address).call())
        .to.equal(true);
    });

    it('should fail to be revoked by owner if revocable not set', async function () {
      const vesting = await this.project.createProxy(TokenVesting)

      await vesting.methods
        .initialize(
          beneficiary, 
          this.start.toString(), 
          this.cliffDuration.toString(), 
          this.duration.toString(), 
          false,
          alunaOrg
        ).send({ from: alunaOrg })
      
      await expectRevert(
        vesting.methods.revoke(this.token.address).send({from: alunaOrg}),
        'TokenVesting: cannot revoke'
      );
    });

    it('should return the non-vested tokens when revoked by owner', async function () {
      await time.increaseTo(
          this.start.add(this.cliffDuration).add(time.duration.weeks(12))
        );

      const vested = vestedAmount(
        amount, 
        await time.latest(), 
        this.start, 
        this.cliffDuration, 
        this.duration
      );

      await this.vesting.methods.revoke(this.token.address)
        .send({from: alunaOrg});

      expect(await this.token.methods.balanceOf(alunaOrg).call())
        .to.be.bignumber.equal(amount.sub(vested))
      
    });

    it('should keep the vested tokens when revoked by owner', async function () {
      await time.increaseTo(
        this.start.add(this.cliffDuration).add(time.duration.weeks(12))
      );

      const vestedPre = vestedAmount(
        amount, 
        await time.latest(), 
        this.start, 
        this.cliffDuration, 
        this.duration
      )

      await this.vesting.methods.revoke(this.token.address)
        .send({from: alunaOrg})

      const vestedPost = await this.vesting.methods.vested(this.token.address)
        .call()

      expect(vestedPre).to.be.bignumber.equal(vestedPost);
    });

    it('should fail to be revoked a second time', async function () {
      await this.vesting.methods.revoke(this.token.address)
        .send({from: alunaOrg})

      await expectRevert(
        this.vesting.methods.revoke(this.token.address).send({from: alunaOrg}),
        'TokenVesting: token already revoked'
      );
    });

    function vestedAmount (total, now, start, cliffDuration, duration) {
      if((now.lt(start.add(cliffDuration)))){
        return new BN(0)
      }

      return total.mul((now.sub(start))).div(duration);
    }
  })

});