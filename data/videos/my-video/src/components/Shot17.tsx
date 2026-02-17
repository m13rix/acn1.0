import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot17: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 8.93s total
	// Original: 0-9s (Left), 9-18s (Right) -> Equal split
	const splitFrame = Math.round(durationInFrames / 2);

	// Left Side Animation: Mechanical Stamp Removal
	// Simulate up/down movement or erasing effect
	const stampY = interpolate(
		frame % 30, // Loop every 1s
		[0, 15, 30],
		[0, -20, 0],
		{easing: Easing.inOut(Easing.quad)}
	);

	// Right Side Animation: Scales Balancing
	// Simulate rotation oscillation
	// Starts animating when right side becomes active or continuous? 
	// "9-18s" implies it starts later or is focused later. 
	// Given "Split-screen comparison", usually both are visible or revealed.
	// Let's assume standard split screen where both might be visible but focus shifts, 
	// OR it's a sequence Left -> Right. 
	// "Left: ... (0-9s). Right: ... (9-18s)" implies sequential focus or appearance.
	// But "Split-screen comparison" implies simultaneous presence.
	// I will implement a split screen where Left is active/highlighted first, then Right.
	
	const rightOpacity = interpolate(frame, [splitFrame - 15, splitFrame], [0.3, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});
	const leftOpacity = interpolate(frame, [splitFrame, splitFrame + 15], [1, 0.3], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	const scaleRotation = interpolate(
		frame,
		[0, durationInFrames],
		[-5, 5],
		{extrapolateRight: 'clamp'}
	);

	return (
		<AbsoluteFill style={{backgroundColor: '#111'}}>
			<div className="flex flex-row w-full h-full">
				{/* Left Side: ZAGS Stamp Removal */}
				<div 
					className="w-1/2 h-full relative overflow-hidden border-r-4 border-white"
					style={{opacity: leftOpacity}}
				>
					<Img
						src={staticFile('zags_stamp_removal.png')}
						style={{
							width: '100%',
							height: '100%',
							objectFit: 'cover',
							transform: `translateY(${stampY}px)`, // Subtle vibration/movement
						}}
					/>
					<div className="absolute bottom-10 left-10 bg-black/70 px-4 py-2 text-white font-mono uppercase">
						Бюрократия
					</div>
				</div>

				{/* Right Side: Judge Scales */}
				<div 
					className="w-1/2 h-full relative overflow-hidden"
					style={{opacity: rightOpacity}}
				>
					<Img
						src={staticFile('judge_scales.png')}
						style={{
							width: '100%',
							height: '100%',
							objectFit: 'cover',
							transform: `rotate(${scaleRotation}deg)`,
							transformOrigin: 'top center',
						}}
					/>
					{/* Coins/Child Metaphor visualization if needed, but using image primarily */}
					<div className="absolute bottom-10 right-10 bg-black/70 px-4 py-2 text-white font-mono uppercase">
						Правосудие
					</div>
				</div>
			</div>

			<Audio src={staticFile('shot17_voice.mp3')} />
		</AbsoluteFill>
	);
};
