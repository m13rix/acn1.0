import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
	random,
} from 'remotion';
import React from 'react';

export const Shot34: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 6.05s total
	// Segments: 0-4s (Backward), 4-6s (Stop/Stamp) -> ~2/3 split
	const splitFrame = Math.round((4 / 6) * durationInFrames);

	// Backward Fly Animation
	// Simulate rapid page flipping/movement
	
	// Use noise to simulate "rapid flipping" visual
	const noiseX = random(frame) * 10 - 5;
	const noiseY = random(frame + 100) * 10 - 5;
	
	// Glitch Effect (around the stop moment)
	const isGlitch = frame > splitFrame - 5 && frame < splitFrame + 10;
	const glitchOffset = isGlitch ? (random(frame + 200) - 0.5) * 50 : 0;
	const glitchColor = isGlitch ? `hue-rotate(${random(frame + 300) * 360}deg)` : 'none';

	// VOID Stamp (Appears after stop)
	const stampStart = splitFrame + 10;
	const stampScale = interpolate(
		frame,
		[stampStart, stampStart + 5],
		[3, 1],
		{extrapolateLeft: 'clamp', easing: Easing.out(Easing.back(2))}
	);
	const stampOpacity = interpolate(frame, [stampStart, stampStart + 2], [0, 1], {extrapolateLeft: 'clamp'});

	return (
		<AbsoluteFill style={{backgroundColor: '#111'}}>
			{/* Calendar Background */}
			<AbsoluteFill
				style={{
					transform: `translate(${noiseX + glitchOffset}px, ${noiseY}px)`,
					filter: glitchColor,
				}}
			>
				<Img
					src={staticFile('calendar_backwards.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						// Simulate backward motion by blurring or scaling
						filter: frame < splitFrame ? 'blur(5px)' : 'none',
					}}
				/>
			</AbsoluteFill>

			{/* Glitch Overlay (Color Channel Split or Lines) */}
			{isGlitch && (
				<AbsoluteFill
					style={{
						backgroundColor: 'rgba(255, 0, 0, 0.2)',
						mixBlendMode: 'screen',
						transform: 'translateX(-10px)',
					}}
				/>
			)}

			{/* VOID Stamp Overlay */}
			<AbsoluteFill className="justify-center items-center">
				<div
					style={{
						opacity: stampOpacity,
						transform: `scale(${stampScale}) rotate(-20deg)`,
						border: '10px solid #cc0000',
						padding: '10px 30px',
						color: '#cc0000',
						fontSize: 100,
						fontWeight: 900,
						fontFamily: 'Inter, sans-serif',
						textTransform: 'uppercase',
						boxShadow: '0 0 20px rgba(204,0,0,0.5)',
						borderRadius: 10,
						backgroundColor: 'rgba(255,255,255,0.8)',
					}}
				>
					VOID
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot34_voice.mp3')} />
		</AbsoluteFill>
	);
};
